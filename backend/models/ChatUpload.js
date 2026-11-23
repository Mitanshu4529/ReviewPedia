import mongoose from 'mongoose';

/**
 * One file uploaded through POST /api/chat/upload.
 *
 * The upload is charged to the owner's storage quota when it is stored, and a
 * message may only attach an upload that belongs to its sender and has not been
 * attached before. Size, type and Cloudinary public ID come from this record,
 * never from the client, so a message cannot point at (and later delete)
 * someone else's file or under-report its size.
 */
const ChatUploadSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  url: { type: String, required: true },
  publicId: { type: String, required: true },
  mediaType: { type: String, enum: ['image', 'video'], required: true },
  size: { type: Number, required: true, min: 0 },
  attachedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null }
}, { timestamps: true });

ChatUploadSchema.index({ url: 1, owner: 1 });

export default mongoose.model('ChatUpload', ChatUploadSchema);
