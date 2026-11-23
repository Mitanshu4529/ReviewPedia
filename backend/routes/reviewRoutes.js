import express from 'express';
import rateLimit from 'express-rate-limit';
import { 
    getReviews, 
    getMapStats,
    getReviewById,
    createReview, 
    deleteReview, 
    updateReview, 
    toggleLikeReview,
    updatePurchaseInfo,
    getLinkMetadata,
    getComments,
    addComment,
    toggleLikeComment,
    deleteComment
} from '../controllers/reviewController.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import { upload, checkUploadQuota } from '../middlewares/uploadMiddleware.js';

const router = express.Router();

router.get('/', getReviews);
router.get('/map-stats', getMapStats);
// The quota gate runs before multer, so nothing reaches Cloudinary for a caller who is out of space.
router.post('/', requireAuth, checkUploadQuota(), upload.array('images', 10), createReview);

// Link preview metadata. Each call makes the server fetch an outside page, so
// it is rate limited per account to keep it from being used as a free proxy.
const metadataLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.user.id, // requireAuth runs first
    message: { success: false, error: 'Too many link previews requested, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test'
});
router.post('/fetch-metadata', requireAuth, metadataLimiter, getLinkMetadata);

// Review details and likes
router.get('/:id', getReviewById);
router.post('/:id/like', requireAuth, toggleLikeReview);
router.put('/:id', requireAuth, checkUploadQuota({ creditReviewMedia: true }), upload.array('images', 10), updateReview);
router.patch('/:id/purchase-info', requireAuth, updatePurchaseInfo);
router.delete('/:id', requireAuth, deleteReview);

// Comments and nested replies
router.get('/:id/comments', getComments);
router.post('/:id/comments', requireAuth, addComment);
router.post('/:id/comments/:commentId/like', requireAuth, toggleLikeComment);
router.delete('/:id/comments/:commentId', requireAuth, deleteComment);

export default router;
