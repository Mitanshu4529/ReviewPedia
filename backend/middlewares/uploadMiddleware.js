import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import User from '../models/User.js';
import Review from '../models/Review.js';
import { isValidObjectId } from '../utils/security.js';

// Configure cloudinary with env variables
// You will need to add these to your .env file
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'demo',
  api_key: process.env.CLOUDINARY_API_KEY || 'demo',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'demo'
});

export const MAX_MEDIA_LIMIT = 128 * 1024 * 1024;   // per-user media quota (128 MB)
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;   // per-file limit for review and chat media
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;    // profile pictures are small cropped images
export const STORAGE_LIMIT_MESSAGE = 'Storage limit reached! You have reached the 128 MB media upload limit. Please delete some reviews or chat media to free up space.';

// A multipart body is slightly larger than the files in it (field values and
// part headers). This much of the declared length is not counted as media.
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;

const IMAGE_FORMATS = ['jpg', 'png', 'jpeg', 'webp', 'gif'];
const MEDIA_FORMATS = [...IMAGE_FORMATS, 'mp4', 'mov', 'avi', 'webm'];

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'reviewpedia',
    resource_type: 'auto',
    allowed_formats: MEDIA_FORMATS
  }
});

const chatStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'reviewpedia_chat',
    resource_type: 'auto', // Allows both image and video
    allowed_formats: MEDIA_FORMATS
  }
});

const avatarStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'reviewpedia',
    resource_type: 'image',
    allowed_formats: IMAGE_FORMATS
  }
});

const imageMimeTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
];

const allowedMimeTypes = [
  ...imageMimeTypes,
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm'
];

const quotaError = () => {
  const err = new Error(STORAGE_LIMIT_MESSAGE);
  err.status = 400;
  return err;
};

// Runs for each file before any of its bytes are handed to the storage engine.
const fileFilter = (req, file, cb) => {
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed formats: JPG, PNG, WEBP, GIF, MP4, MOV, WEBM.`), false);
  }
  // Set by checkUploadQuota: with no quota left, no file is accepted at all.
  if (typeof req.uploadQuotaRemaining === 'number' && req.uploadQuotaRemaining <= 0) {
    return cb(quotaError(), false);
  }
  cb(null, true);
};

const avatarFileFilter = (req, file, cb) => {
  if (imageMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}. Profile pictures must be JPG, PNG, WEBP or GIF images.`), false);
  }
};

/**
 * Answers an upload request that is refused before its body has been read.
 * The body is read and thrown away first (it goes nowhere): answering while the
 * browser is still sending makes it report a connection reset instead of
 * showing the error message.
 */
const rejectUpload = (req, res, status, body) => {
  const send = () => { if (!res.headersSent) res.status(status).json(body); };
  if (req.complete) return send();
  req.once('end', send);
  req.once('error', () => {});
  req.resume();
};

/**
 * Quota gate that runs BEFORE multer, i.e. before any byte is streamed to
 * Cloudinary. The request's Content-Length is an upper bound on the size of the
 * files in it, so a request that cannot fit in the caller's remaining quota is
 * refused without uploading anything. The exact check (on the real file sizes)
 * still happens in the controllers afterwards.
 *
 * `creditReviewMedia`: on a review edit the caller may be replacing media, so the
 * review's current media is credited back for this early check only.
 */
export const checkUploadQuota = ({ creditReviewMedia = false } = {}) => async (req, res, next) => {
  try {
    if (!req.is('multipart/form-data')) return next();

    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared < 0) {
      return res.status(411).json({ success: false, error: { message: 'Content-Length is required for uploads' } });
    }

    const account = await User.findById(req.user.id).select('totalMediaBytes').lean();
    if (!account) {
      return res.status(401).json({ success: false, error: 'Account no longer exists.' });
    }
    let used = account.totalMediaBytes || 0;

    if (creditReviewMedia && isValidObjectId(req.params.id)) {
      const review = await Review.findById(req.params.id).select('user.id review.media.size').lean();
      if (review?.user?.id && review.user.id.toString() === req.user.id) {
        used -= (review.review?.media || []).reduce((sum, m) => sum + (m.size || 0), 0);
      }
    }

    const remaining = MAX_MEDIA_LIMIT - Math.max(0, used);
    const mediaUpperBound = Math.max(0, declared - MULTIPART_OVERHEAD_ALLOWANCE);
    if (mediaUpperBound > remaining) {
      return rejectUpload(req, res, 400, { error: STORAGE_LIMIT_MESSAGE });
    }

    req.uploadQuotaRemaining = remaining;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * For routes with their own (smaller) file limit: refuses a body that is
 * declared larger than the limit before multer starts streaming it, and tells
 * the error handler which limit to name.
 */
export const limitUploadSize = (maxBytes, label) => (req, res, next) => {
  req.uploadLimitLabel = label;
  const declared = Number(req.headers['content-length']);
  if (req.is('multipart/form-data') && Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD_ALLOWANCE) {
    return rejectUpload(req, res, 413, { success: false, error: `File is too large (max ${label})` });
  }
  next();
};

export const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_UPLOAD_BYTES }, // 25 MB max
  fileFilter: fileFilter
});

export const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES }, // 25 MB max
  fileFilter: fileFilter
});

// Profile pictures: images only, 2 MB. (The general uploader accepted 25 MB video here.)
export const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
  fileFilter: avatarFileFilter
});

export const cloudinaryInstance = cloudinary;
