import Review from '../models/Review.js';
import User from '../models/User.js';
import Comment from '../models/Comment.js';
import mongoose from 'mongoose';
import { latLngToCell, cellToBoundary, isValidCell, getResolution } from 'h3-js';
import { cloudinaryInstance, MAX_MEDIA_LIMIT, STORAGE_LIMIT_MESSAGE, reserveMediaBytes, releaseMediaBytes } from '../middlewares/uploadMiddleware.js';
import { fetchUrlMetadata } from '../utils/metadataFetcher.js';
import { isValidObjectId, httpError } from '../utils/security.js';

const LEGACY_LIST_CAP = 500;      // bare-array response for callers that do not paginate
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_MAP_CELLS = 5000;       // upper bound on cells returned by the map statistics
const MAX_CELL_COORDS = 1000;     // upper bound on distinct coordinates matched for one hexagon
const MAX_REVIEW_TEXT = 5000;
const MAX_SHORT_FIELD = 200;
const MAX_COMMENT_TEXT = 2000;

// A review or comment belongs to the account whose id is stored on it. Matching
// on the display name is not ownership: imported reviews carry a real person's
// name and no account id, so anyone registering that name could edit or delete them.
const isOwnerOrAdmin = (doc, user) => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return !!(doc?.user?.id && user.id && doc.user.id.toString() === user.id.toString());
};

const parseBody = (req) => {
    if (typeof req.body?.data !== 'string') return req.body || {};
    try {
        const parsed = JSON.parse(req.body.data);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        throw httpError(400, 'Malformed review data');
    }
};

const cleanString = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Purchase links are shown as clickable links, so only web addresses are kept.
// A link typed without a scheme ("amazon.in/...") is allowed; any other scheme
// (javascript:, data:, ...) is refused.
const MAX_LINK_LENGTH = 2048;
const cleanWebLink = (value) => {
    if (typeof value !== 'string') return null;
    const link = value.trim();
    if (!link) return '';
    if (link.length > MAX_LINK_LENGTH) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) && !/^https?:\/\//i.test(link)) return null;
    return link;
};
const META_FIELDS = { title: 300, description: 1000, image: MAX_LINK_LENGTH, siteName: 200, url: MAX_LINK_LENGTH };
const EMPTY_META = { title: '', description: '', image: '', siteName: '', url: '' };

/**
 * Validates the purchase fields of a request. Returns { error } or an object
 * holding only the fields that were sent, cleaned.
 */
const parsePurchaseFields = ({ purchaseLink, purchaseType, purchaseMeta } = {}) => {
    const out = {};
    if (purchaseLink !== undefined) {
        const link = cleanWebLink(purchaseLink);
        if (link === null) return { error: 'Purchase link must be a web address (http or https)' };
        out.purchaseLink = link;
    }
    if (purchaseType !== undefined && purchaseType !== null && purchaseType !== '') {
        if (typeof purchaseType !== 'string') return { error: 'Invalid purchase type' };
        out.purchaseType = purchaseType.trim().slice(0, 30);
    }
    if (purchaseMeta !== undefined) {
        if (purchaseMeta === null || purchaseMeta === '') {
            out.purchaseMeta = { ...EMPTY_META };
        } else if (typeof purchaseMeta !== 'object' || Array.isArray(purchaseMeta)) {
            return { error: 'Invalid purchase details' };
        } else {
            const meta = {};
            for (const [field, max] of Object.entries(META_FIELDS)) {
                meta[field] = cleanString(purchaseMeta[field], max);
            }
            meta.image = cleanWebLink(meta.image) ?? '';
            meta.url = cleanWebLink(meta.url) ?? '';
            out.purchaseMeta = meta;
        }
    }
    return out;
};

// Ratings are whole or half stars from 0.5 to 5.
const parseRating = (value) => {
    const rating = Number(value);
    if (!Number.isFinite(rating) || rating < 0.5 || rating > 5 || (rating * 2) % 1 !== 0) return null;
    return rating;
};

// Removes files that were uploaded for a request that is then rejected, so
// failed requests do not leave orphaned media in Cloudinary.
const discardUploads = async (files) => {
    for (const file of files || []) {
        if (!file?.filename) continue;
        const isVideo = file.mimetype?.startsWith('video/');
        await cloudinaryInstance.uploader
            .destroy(file.filename, { resource_type: isVideo ? 'video' : 'image' })
            .catch(e => console.error('Cloudinary cleanup failed', e));
    }
};

// Coordinates of a review whose author chose "approximate" are rounded to two
// decimals (about 1 km) before they are stored, and again on the way out, so the
// API can never return more precision than the reviewer chose.
const coarsenCoordinate = (value) => Math.round(value * 100) / 100;

const publicLocation = (location) => {
    if (!location || location.precision !== 'approximate') return location;
    return {
        ...location,
        lat: Number.isFinite(location.lat) ? coarsenCoordinate(location.lat) : location.lat,
        lng: Number.isFinite(location.lng) ? coarsenCoordinate(location.lng) : location.lng
    };
};

// Shared by the list and the map statistics so both always describe the same set.
const buildListFilter = (query) => {
        const search = typeof query.search === 'string' ? query.search.trim() : '';
        const category = typeof query.category === 'string' ? query.category.trim() : '';
        let filter = {};
        if (search) {
          filter = { $text: { $search: search } };
        }
        if (category && category.toLowerCase() !== 'all') {
          const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const words = category.split(/[\s,&]+/).filter(w => w.length > 2).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          const pattern = words.length > 0 ? `(${escaped}|${words.join('|')})` : escaped;
          filter['product.category'] = { $regex: new RegExp(pattern, 'i') };
        }
        return filter;
};

// Adds the optional narrowing filters of the list endpoint. Returns an error
// message for a malformed value, or null.
const applyListFilters = async (filter, query) => {
    if (query.h3Index !== undefined) {
        // Reviews of one map marker: the stored (resolution 9) cell.
        if (typeof query.h3Index !== 'string' || !/^[0-9a-f]{15}$/i.test(query.h3Index)) return 'Invalid h3Index';
        filter['location.h3Index'] = query.h3Index.toLowerCase();
    }
    if (query.userId !== undefined) {
        if (!isValidObjectId(query.userId)) return 'Invalid userId';
        filter['user.id'] = new mongoose.Types.ObjectId(query.userId);
    }
    if (query.cell !== undefined) {
        // Reviews inside a hexagon of any resolution (business view). Cells are
        // derived from coordinates, so the matching coordinates are looked up first.
        if (typeof query.cell !== 'string' || !isValidCell(query.cell)) return 'Invalid cell';
        const resolution = getResolution(query.cell);
        const groups = await Review.aggregate([
            { $match: { ...filter } },
            { $group: { _id: { lat: '$location.lat', lng: '$location.lng' }, count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);
        const coords = groups
            .filter(g => Number.isFinite(g._id.lat) && Number.isFinite(g._id.lng) &&
                latLngToCell(g._id.lat, g._id.lng, resolution) === query.cell.toLowerCase())
            .slice(0, MAX_CELL_COORDS)
            .map(g => ({ 'location.lat': g._id.lat, 'location.lng': g._id.lng }));
        // No coordinate falls in the cell: match nothing.
        filter.$or = coords.length > 0 ? coords : [{ _id: null }];
    }
    return null;
};

// Attaches author avatars and comment counts, and applies the location precision
// the reviewer chose, to a page of reviews.
const normalizeReviews = async (reviews) => {
        const reviewIds = reviews.map(r => r._id);
        const userIds = reviews.map(r => r.user?.id).filter(Boolean);
        const userNames = reviews.map(r => r.user?.name).filter(Boolean);

        const [users, commentCounts] = await Promise.all([
            User.find({
                $or: [
                    { _id: { $in: userIds } },
                    { username: { $in: userNames } }
                ]
            }, 'username profilePic').lean(),
            Comment.aggregate([
                { $match: { reviewId: { $in: reviewIds } } },
                { $group: { _id: '$reviewId', count: { $sum: 1 } } }
            ])
        ]);

        const userMap = {};
        users.forEach(u => {
            if (u._id) userMap[u._id.toString()] = u.profilePic || '';
            if (u.username) userMap[u.username] = u.profilePic || '';
        });

        const countMap = {};
        commentCounts.forEach(c => {
            if (c._id) countMap[c._id.toString()] = c.count;
        });

        const normalized = reviews.map(r => {
            const obj = r.toObject();
            obj.id = obj._id.toString();
            obj.likes = obj.likes || [];
            obj.commentsCount = countMap[obj.id] || 0;
            // Imported reviews have no account: do not show a same-named user's avatar on them.
            const pic = (obj.user?.id && userMap[obj.user.id.toString()]) ||
                (!obj.source?.isScraped && obj.user?.name && userMap[obj.user.name]) || '';
            obj.user = {
                ...obj.user,
                profilePic: pic
            };
            obj.location = publicLocation(obj.location);
            return obj;
        });
        return normalized;
};

/**
 * GET /api/reviews
 *
 * Without `limit`/`cursor` the response is the legacy bare array (newest first,
 * capped at LEGACY_LIST_CAP) so older clients keep working.
 *
 * With `limit` (1..MAX_PAGE_SIZE) and/or `cursor` the response is a page:
 *   { reviews, total, limit, nextCursor }
 * `nextCursor` is the id to pass as `cursor` for the next page, or null at the
 * end. Paging is by id, so reviews posted while paging do not shift pages.
 *
 * Filters (both modes): search, category, h3Index (map marker), cell (hexagon),
 * userId (author).
 */
export const getReviews = async (req, res, next) => {
    try {
        const filter = buildListFilter(req.query);
        const filterError = await applyListFilters(filter, req.query);
        if (filterError) return res.status(400).json({ error: filterError });

        const paginated = req.query.limit !== undefined || req.query.cursor !== undefined;
        if (!paginated) {
            const reviews = await Review.find(filter).sort({ _id: -1 }).limit(LEGACY_LIST_CAP);
            return res.json(await normalizeReviews(reviews));
        }

        let limit = DEFAULT_PAGE_SIZE;
        if (req.query.limit !== undefined) {
            limit = Number(req.query.limit);
            if (!Number.isInteger(limit) || limit < 1) return res.status(400).json({ error: 'limit must be a positive integer' });
            limit = Math.min(limit, MAX_PAGE_SIZE);
        }
        const pageFilter = { ...filter };
        if (req.query.cursor !== undefined) {
            if (!isValidObjectId(req.query.cursor)) return res.status(400).json({ error: 'Invalid cursor' });
            pageFilter._id = { $lt: new mongoose.Types.ObjectId(req.query.cursor) };
        }

        // One extra row tells whether another page exists.
        const [rows, total] = await Promise.all([
            Review.find(pageFilter).sort({ _id: -1 }).limit(limit + 1),
            Review.countDocuments(filter)
        ]);
        const page = rows.slice(0, limit);
        res.json({
            reviews: await normalizeReviews(page),
            total,
            limit,
            nextCursor: rows.length > limit ? page[page.length - 1]._id.toString() : null
        });
    } catch (err) {
        next(err);
    }
};

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * GET /api/reviews/map-stats
 *
 * Map statistics over EVERY review matching search/category (not over a page).
 *  - no `resolution`: one entry per stored map cell, with a marker position
 *    (consumer map markers and their counts)
 *  - `resolution` (1..10): hexagon density at that H3 resolution, with the
 *    hexagon outline (business map)
 * Each cell: { h3Index, count, avgRating, minRating, maxRating, lat, lng, boundary? }
 */
export const getMapStats = async (req, res, next) => {
    try {
        const filter = buildListFilter(req.query);

        let resolution = null;
        if (req.query.resolution !== undefined) {
            resolution = Number(req.query.resolution);
            if (!Number.isInteger(resolution) || resolution < 1 || resolution > 10) {
                return res.status(400).json({ error: 'resolution must be an integer from 1 to 10' });
            }
        }

        const rated = { $gt: ['$review.rating', 0] };
        const groups = await Review.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: { lat: '$location.lat', lng: '$location.lng' },
                    h3Index: { $first: '$location.h3Index' },
                    precision: { $first: '$location.precision' },
                    count: { $sum: 1 },
                    ratedCount: { $sum: { $cond: [rated, 1, 0] } },
                    ratingSum: { $sum: { $cond: [rated, '$review.rating', 0] } },
                    minRating: { $min: { $cond: [rated, '$review.rating', null] } },
                    maxRating: { $max: { $cond: [rated, '$review.rating', null] } }
                }
            }
        ]);

        const cells = new Map();
        let total = 0;
        for (const g of groups) {
            const { lat, lng } = g._id;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            total += g.count;
            const key = resolution === null ? g.h3Index : latLngToCell(lat, lng, resolution);
            if (!key) continue;
            let cell = cells.get(key);
            if (!cell) {
                const position = publicLocation({ lat, lng, precision: g.precision });
                cell = { h3Index: key, count: 0, ratedCount: 0, ratingSum: 0, minRating: null, maxRating: null, lat: position.lat, lng: position.lng };
                cells.set(key, cell);
            }
            cell.count += g.count;
            cell.ratedCount += g.ratedCount;
            cell.ratingSum += g.ratingSum;
            if (g.minRating !== null && g.minRating !== undefined) cell.minRating = cell.minRating === null ? g.minRating : Math.min(cell.minRating, g.minRating);
            if (g.maxRating !== null && g.maxRating !== undefined) cell.maxRating = cell.maxRating === null ? g.maxRating : Math.max(cell.maxRating, g.maxRating);
        }

        const sorted = [...cells.values()].sort((a, b) => b.count - a.count);
        const out = sorted.slice(0, MAX_MAP_CELLS).map(c => {
            const cell = {
                h3Index: c.h3Index,
                count: c.count,
                avgRating: c.ratedCount > 0 ? round1(c.ratingSum / c.ratedCount) : null,
                minRating: c.minRating,
                maxRating: c.maxRating,
                lat: c.lat,
                lng: c.lng
            };
            if (resolution !== null) cell.boundary = cellToBoundary(c.h3Index);
            return cell;
        });

        res.json({ total, resolution, truncated: sorted.length > MAX_MAP_CELLS, cells: out });
    } catch (err) {
        next(err);
    }
};

export const createReview = async (req, res, next) => {
    const files = req.files || (req.file ? [req.file] : []);
    try {
        // Since we are using FormData, JSON is sent as a string inside req.body.data
        const bodyData = parseBody(req);

        // Validate before anything is written. Only these fields are taken from
        // the client; likes, trust score and source are never client-controlled.
        const productName = cleanString(bodyData.product?.name, MAX_SHORT_FIELD);
        const rating = parseRating(bodyData.review?.rating);
        const text = cleanString(bodyData.review?.text, MAX_REVIEW_TEXT);
        // A review is never pinned to a default place: the client must send the
        // location the reviewer shared or picked. (A missing location used to be
        // stored silently as central Delhi.)
        const isCoordinate = (v) => (typeof v === 'number') || (typeof v === 'string' && v.trim() !== '');
        const hasLocation = isCoordinate(bodyData.location?.lat) && isCoordinate(bodyData.location?.lng);
        let lat = hasLocation ? Number(bodyData.location.lat) : NaN;
        let lng = hasLocation ? Number(bodyData.location.lng) : NaN;
        // Exact coordinates are stored only when the reviewer asked for that.
        const precision = bodyData.location?.precision === 'exact' ? 'exact' : 'approximate';

        let validationError = null;
        if (!hasLocation) validationError = 'A location is required: allow location access or pick a place on the map';
        else if (!productName) validationError = 'Product name is required';
        else if (rating === null) validationError = 'Rating must be between 0.5 and 5 in steps of 0.5';
        else if (typeof bodyData.review?.text === 'string' && bodyData.review.text.length > MAX_REVIEW_TEXT) {
            validationError = `Review text is too long (max ${MAX_REVIEW_TEXT} characters)`;
        } else if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            validationError = 'Invalid location coordinates';
        }
        if (validationError) {
            await discardUploads(files);
            return res.status(400).json({ error: validationError });
        }

        if (precision === 'approximate') {
            lat = coarsenCoordinate(lat);
            lng = coarsenCoordinate(lng);
        }

        let totalNewSize = 0;
        for (const file of files) {
            totalNewSize += (file.size || file.bytes || 0);
        }

        const userDoc = await User.findById(req.user.id);
        if (!userDoc) {
            await discardUploads(files);
            return res.status(401).json({ error: 'Account no longer exists' });
        }

        if (totalNewSize > 0) {
            // Conditional $inc: the quota check and the update happen atomically, so
            // parallel uploads cannot both slip under the limit.
            const reserved = await User.findOneAndUpdate(
                { _id: userDoc._id, $expr: { $lte: [{ $add: [{ $ifNull: ['$totalMediaBytes', 0] }, totalNewSize] }, MAX_MEDIA_LIMIT] } },
                { $inc: { totalMediaBytes: totalNewSize } }
            );
            if (!reserved) {
                await discardUploads(files);
                return res.status(400).json({ error: STORAGE_LIMIT_MESSAGE });
            }
        }

        let mediaArray = [];
        for (const file of files) {
            const fileSize = file.size || file.bytes || 0;
            const isVideo = file.mimetype?.startsWith('video/') || file.path?.match(/\.(mp4|mov|avi|webm)$/i);
            mediaArray.push({ type: isVideo ? 'video' : 'image', url: file.path, size: fileSize });
        }

        const newReview = new Review({
           product: {
               name: productName,
               brand: cleanString(bodyData.product?.brand, MAX_SHORT_FIELD),
               category: cleanString(bodyData.product?.category, MAX_SHORT_FIELD)
           },
           review: {
               title: cleanString(bodyData.review?.title, 100) || text.substring(0, 50),
               text,
               rating,
               media: mediaArray
           },
           user: {
               id: userDoc._id,
               name: userDoc.username
           },
           source: {
               platform: 'Reviewpedia',
               isScraped: false
           },
           // No trust model exists yet, so no trust score is invented for new reviews.
           analytics: { trustScore: 0, sentimentScore: rating / 5 },
           metadata: { date: new Date().toISOString().split('T')[0] },
           location: {
               city: cleanString(bodyData.location?.city, 100) || 'Local',
               lat,
               lng,
               precision,
               h3Index: latLngToCell(lat, lng, 9)
           }
        });
        try {
            await newReview.save();
        } catch (saveErr) {
            if (totalNewSize > 0) {
                await User.findByIdAndUpdate(userDoc._id, { $inc: { totalMediaBytes: -totalNewSize } });
            }
            await discardUploads(files);
            throw saveErr;
        }

        const rObj = newReview.toObject();
        rObj.id = rObj._id.toString();
        rObj.location = publicLocation(rObj.location);
        rObj.user = {
            ...rObj.user,
            profilePic: userDoc?.profilePic || ''
        };

        res.status(201).json(rObj);
    } catch (err) {
        next(err);
    }
};

export const deleteReview = async (req, res, next) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid review id' });
        }
        const review = await Review.findById(req.params.id);
        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }

        // Authorize delete
        if (!isOwnerOrAdmin(review, req.user)) {
            return res.status(403).json({ error: 'You are not authorized to delete this review' });
        }

        let bytesToSubtract = 0;
        // Delete images from Cloudinary if they exist
        if (review.review?.media && review.review.media.length > 0) {
            for (let m of review.review.media) {
                bytesToSubtract += (m.size || 0);
                if (m.url && m.url.includes('cloudinary.com')) {
                    const parts = m.url.split('/');
                    const filename = parts.pop().split('.')[0]; // strip extension
                    const folder = parts.pop(); // 'reviewpedia'
                    const publicId = `${folder}/${filename}`;
                    await cloudinaryInstance.uploader.destroy(publicId, {
                        resource_type: m.type === 'video' ? 'video' : 'image'
                    }).catch(e => console.error("Cloudinary delete failed", e));
                }
            }
        }

        if (bytesToSubtract > 0 && review.user?.id) {
            // Credit the storage back to the review's author (an admin may be the one deleting).
            await releaseMediaBytes(review.user.id, bytesToSubtract);
        }

        await Comment.deleteMany({ reviewId: review._id });
        await Review.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Review deleted successfully' });
    } catch (err) {
        next(err);
    }
};

export const updateReview = async (req, res, next) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid review id' });
        }
        const review = await Review.findById(req.params.id);
        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }

        // Authorize edit
        if (!isOwnerOrAdmin(review, req.user)) {
            return res.status(403).json({ error: 'You are not authorized to edit this review' });
        }

        const bodyData = parseBody(req);

        // The client says which existing media to keep, but the stored objects are
        // what is kept: a client-supplied URL or size is never written back. (A
        // foreign URL here would later be deleted from Cloudinary with the review.)
        const requestedKeep = new Set(
            (Array.isArray(bodyData.existingMedia) ? bodyData.existingMedia : [])
                .map(m => m?.url)
                .filter(u => typeof u === 'string')
        );
        const existingMedia = (review.review?.media || [])
            .filter(m => requestedKeep.has(m.url))
            .map(m => ({ type: m.type, url: m.url, size: m.size || 0 }));

        if (bodyData.review?.rating !== undefined && parseRating(bodyData.review.rating) === null) {
            await discardUploads(req.files);
            return res.status(400).json({ error: 'Rating must be between 0.5 and 5 in steps of 0.5' });
        }
        if (typeof bodyData.review?.text === 'string' && bodyData.review.text.length > MAX_REVIEW_TEXT) {
            await discardUploads(req.files);
            return res.status(400).json({ error: `Review text is too long (max ${MAX_REVIEW_TEXT} characters)` });
        }
        const purchase = parsePurchaseFields(bodyData.product || {});
        if (purchase.error) {
            await discardUploads(req.files);
            return res.status(400).json({ error: purchase.error });
        }

        // Media is only rewritten when the request carries a `review` object (see
        // below). Without one, uploads have nowhere to go and nothing is removed.
        const mediaIsRewritten = !!bodyData.review;
        let files = req.files || (req.file ? [req.file] : []);
        if (!mediaIsRewritten && files.length > 0) {
            await discardUploads(files);
            files = [];
        }
        const toMediaItem = (file) => {
            const isVideo = file.mimetype?.startsWith('video/') || /\.(mp4|mov|avi|webm)$/i.test(file.path || '');
            return { type: isVideo ? 'video' : 'image', url: file.path, size: file.size || file.bytes || 0 };
        };

        // Build the final media list first; everything else follows from it.
        let updatedMediaArray = [];
        let usedFiles = files;
        if (Array.isArray(bodyData.mediaOrder)) {
            usedFiles = [];
            const seenUrls = new Set();
            let newFileIdx = 0;
            for (const item of bodyData.mediaOrder) {
                if (item?.type === 'existing') {
                    const found = existingMedia.find(m => m.url === item.url);
                    if (found && !seenUrls.has(found.url)) {
                        seenUrls.add(found.url);
                        updatedMediaArray.push(found);
                    }
                } else if (item?.type === 'new' && newFileIdx < files.length) {
                    const file = files[newFileIdx++];
                    usedFiles.push(file);
                    updatedMediaArray.push(toMediaItem(file));
                }
            }
        } else {
            updatedMediaArray = [...existingMedia, ...files.map(toMediaItem)];
        }
        // Uploads the final list does not reference are deleted now, not left orphaned.
        const unusedFiles = files.filter(f => !usedFiles.includes(f));
        if (unusedFiles.length > 0) await discardUploads(unusedFiles);
        files = usedFiles;

        const totalNewSize = files.reduce((sum, f) => sum + (f.size || f.bytes || 0), 0);

        // Old media the edit drops, judged against the final list (so an item the
        // client kept but left out of mediaOrder is removed and credited too). It is
        // deleted from Cloudinary only after the edit has been saved: deleting first
        // left the review pointing at missing files whenever the save then failed.
        const oldMedia = review.review?.media || [];
        const finalUrls = new Set(updatedMediaArray.map(m => m.url));
        const removedMedia = mediaIsRewritten ? oldMedia.filter(oldM => !finalUrls.has(oldM.url)) : [];
        const removedOldSize = removedMedia.reduce((sum, m) => sum + (m.size || 0), 0);

        const diff = totalNewSize - removedOldSize;
        // Storage is accounted against the review's author.
        const authorId = review.user?.id || null;

        if (authorId && diff > 0) {
            if (!(await reserveMediaBytes(authorId, diff))) {
                await discardUploads(files);
                return res.status(400).json({ error: STORAGE_LIMIT_MESSAGE });
            }
        } else if (authorId && diff < 0) {
            await releaseMediaBytes(authorId, -diff);
        }

        if (cleanString(bodyData.product?.name, MAX_SHORT_FIELD)) review.product.name = cleanString(bodyData.product.name, MAX_SHORT_FIELD);
        if (bodyData.product?.brand !== undefined) review.product.brand = cleanString(bodyData.product.brand, MAX_SHORT_FIELD);
        if (cleanString(bodyData.product?.category, MAX_SHORT_FIELD)) review.product.category = cleanString(bodyData.product.category, MAX_SHORT_FIELD);
        Object.assign(review.product, purchase);

        if (bodyData.review) {
            if (typeof bodyData.review.text === 'string') {
                review.review.text = bodyData.review.text.trim();
                review.review.title = review.review.text.substring(0, 50);
            }
            if (bodyData.review.rating !== undefined) {
                review.review.rating = parseRating(bodyData.review.rating);
                if (review.analytics) review.analytics.sentimentScore = review.review.rating / 5;
            }
            review.review.media = updatedMediaArray;
        }

        try {
            await review.save();
        } catch (saveErr) {
            // Undo the storage accounting and drop the new uploads; the old media is untouched.
            if (authorId && diff > 0) await releaseMediaBytes(authorId, diff);
            if (authorId && diff < 0) await User.updateOne({ _id: authorId }, { $inc: { totalMediaBytes: -diff } });
            await discardUploads(files);
            throw saveErr;
        }

        for (const oldM of removedMedia) {
            if (oldM.url && oldM.url.includes('cloudinary.com')) {
                const parts = oldM.url.split('/');
                const filename = parts.pop().split('.')[0];
                const folder = parts.pop();
                await cloudinaryInstance.uploader.destroy(`${folder}/${filename}`, {
                    resource_type: oldM.type === 'video' ? 'video' : 'image'
                }).catch(e => console.error("Cloudinary destroy error:", e));
            }
        }

        const rObj = review.toObject();
        rObj.id = rObj._id.toString();
        rObj.location = publicLocation(rObj.location);

        res.json(rObj);
    } catch (err) {
        next(err);
    }
};

export const toggleLikeReview = async (req, res, next) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid review id' });
        }
        const review = await Review.findById(req.params.id);
        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }

        const userId = req.user?.id?.toString();
        if (!userId) {
            return res.status(401).json({ error: 'User authentication required' });
        }

        const currentLikes = Array.isArray(review.likes) ? review.likes : [];
        const hasLiked = currentLikes.includes(userId);

        let updatedReview;
        if (hasLiked) {
            updatedReview = await Review.findByIdAndUpdate(
                req.params.id,
                { $pull: { likes: userId } },
                { new: true }
            );
        } else {
            updatedReview = await Review.findByIdAndUpdate(
                req.params.id,
                { $addToSet: { likes: userId } },
                { new: true }
            );
        }

        const updatedLikes = updatedReview ? (updatedReview.likes || []) : [];

        res.json({
            success: true,
            likes: updatedLikes,
            likesCount: updatedLikes.length,
            isLiked: !hasLiked
        });
    } catch (err) {
        next(err);
    }
};

export const getReviewById = async (req, res, next) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid review id' });
        }
        const review = await Review.findById(req.params.id);
        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }

        let profilePic = '';
        if (review.user?.id) {
            const u = await User.findById(review.user.id, 'profilePic').lean();
            if (u?.profilePic) profilePic = u.profilePic;
        } else if (review.user?.name) {
            const u = await User.findOne({ username: review.user.name }, 'profilePic').lean();
            if (u?.profilePic) profilePic = u.profilePic;
        }

        const commentsCount = await Comment.countDocuments({ reviewId: review._id });

        const obj = review.toObject();
        obj.id = obj._id.toString();
        obj.likes = obj.likes || [];
        obj.commentsCount = commentsCount;
        obj.location = publicLocation(obj.location);
        obj.user = {
            ...obj.user,
            profilePic: profilePic || obj.user?.profilePic || ''
        };

        res.json(obj);
    } catch (err) {
        next(err);
    }
};

export const getComments = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ error: 'Invalid review id' });
        }
        const comments = await Comment.find({ reviewId: id }).sort({ createdAt: 1 }).limit(2000).lean();

        const userIds = comments.map(c => c.user?.id).filter(Boolean);
        const userNames = comments.map(c => c.user?.name).filter(Boolean);

        const users = await User.find({
            $or: [
                { _id: { $in: userIds } },
                { username: { $in: userNames } }
            ]
        }, 'username profilePic').lean();

        const userMap = {};
        users.forEach(u => {
            if (u._id) userMap[u._id.toString()] = u.profilePic || '';
            if (u.username) userMap[u.username] = u.profilePic || '';
        });

        const normalized = comments.map(c => ({
            ...c,
            id: c._id.toString(),
            reviewId: c.reviewId.toString(),
            parentId: c.parentId ? c.parentId.toString() : null,
            likes: c.likes || [],
            user: {
                ...c.user,
                profilePic: (c.user?.id && userMap[c.user.id.toString()]) || (c.user?.name && userMap[c.user.name]) || c.user?.profilePic || ''
            }
        }));

        res.json(normalized);
    } catch (err) {
        next(err);
    }
};

export const addComment = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { text, parentId } = req.body;

        if (typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Comment text is required' });
        }
        if (text.length > MAX_COMMENT_TEXT) {
            return res.status(400).json({ error: `Comment is too long (max ${MAX_COMMENT_TEXT} characters)` });
        }
        if (!isValidObjectId(id) || (parentId && !isValidObjectId(parentId))) {
            return res.status(400).json({ error: 'Invalid id' });
        }

        const review = await Review.findById(id);
        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }

        let validParentId = null;
        if (parentId) {
            const parentComment = await Comment.findById(parentId);
            // A reply must stay inside the review its parent belongs to.
            if (!parentComment || parentComment.reviewId.toString() !== review._id.toString()) {
                return res.status(404).json({ error: 'Parent comment not found' });
            }
            validParentId = parentComment._id;
        }

        const newComment = new Comment({
            reviewId: review._id,
            parentId: validParentId,
            user: {
                id: req.user.id,
                name: req.user.username,
                profilePic: req.user.profilePic || ''
            },
            text: text.trim(),
            likes: []
        });

        await newComment.save();

        const obj = newComment.toObject();
        obj.id = obj._id.toString();
        obj.reviewId = obj.reviewId.toString();
        obj.parentId = obj.parentId ? obj.parentId.toString() : null;

        res.status(201).json(obj);
    } catch (err) {
        next(err);
    }
};

export const toggleLikeComment = async (req, res, next) => {
    try {
        const { commentId } = req.params;
        if (!isValidObjectId(commentId)) {
            return res.status(400).json({ error: 'Invalid comment id' });
        }
        const comment = await Comment.findById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        const userId = req.user?.id?.toString();
        if (!userId) {
            return res.status(401).json({ error: 'User authentication required' });
        }

        const currentLikes = Array.isArray(comment.likes) ? comment.likes : [];
        const hasLiked = currentLikes.includes(userId);

        let updatedComment;
        if (hasLiked) {
            updatedComment = await Comment.findByIdAndUpdate(
                commentId,
                { $pull: { likes: userId } },
                { new: true }
            );
        } else {
            updatedComment = await Comment.findByIdAndUpdate(
                commentId,
                { $addToSet: { likes: userId } },
                { new: true }
            );
        }

        const updatedLikes = updatedComment ? (updatedComment.likes || []) : [];

        res.json({
            success: true,
            likes: updatedLikes,
            likesCount: updatedLikes.length,
            isLiked: !hasLiked
        });
    } catch (err) {
        next(err);
    }
};

export const deleteComment = async (req, res, next) => {
    try {
        const { commentId } = req.params;
        if (!isValidObjectId(commentId)) {
            return res.status(400).json({ error: 'Invalid comment id' });
        }
        const comment = await Comment.findById(commentId);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (comment.reviewId.toString() !== req.params.id) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (!isOwnerOrAdmin(comment, req.user)) {
            return res.status(403).json({ error: 'Not authorized to delete this comment' });
        }

        const deleteDescendants = async (parentId) => {
            const children = await Comment.find({ parentId });
            for (const child of children) {
                await deleteDescendants(child._id);
            }
            await Comment.deleteMany({ parentId });
        };

        await deleteDescendants(comment._id);
        await Comment.findByIdAndDelete(commentId);

        res.json({ success: true, message: 'Comment deleted successfully' });
    } catch (err) {
        next(err);
    }
};

export const updatePurchaseInfo = async (req, res, next) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid review id' });
        }
        const review = await Review.findById(req.params.id);
        if (!review) {
            return res.status(404).json({ error: 'Review not found' });
        }

        if (!isOwnerOrAdmin(review, req.user)) {
            return res.status(403).json({ error: 'You are not authorized to update this review' });
        }

        const purchase = parsePurchaseFields(req.body || {});
        if (purchase.error) {
            return res.status(400).json({ error: purchase.error });
        }
        if (!review.product) review.product = {};
        Object.assign(review.product, purchase);
        if (!review.product.purchaseType) review.product.purchaseType = 'online';

        await review.save();

        const rObj = review.toObject();
        rObj.id = rObj._id.toString();
        rObj.location = publicLocation(rObj.location);

        res.json(rObj);
    } catch (err) {
        next(err);
    }
};

export const getLinkMetadata = async (req, res, next) => {
    try {
        const { url } = req.body;
        if (!url || typeof url !== 'string' || url.trim() === '') {
            return res.status(400).json({ error: 'A valid URL is required' });
        }

        const metadata = await fetchUrlMetadata(url);
        if (!metadata) {
            return res.status(422).json({ error: 'Could not fetch preview for this link' });
        }

        res.json({ success: true, metadata });
    } catch (err) {
        next(err);
    }
};

