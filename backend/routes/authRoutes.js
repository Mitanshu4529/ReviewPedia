import express from 'express';
import { 
    register, 
    login, 
    logout, 
    getMe, 
    updateProfile, 
    getUserByUsername, 
    deleteAccount,
    sendSignupOtp,
    sendEmailUpdateOtp,
    sendForgotPasswordOtp,
    resetPassword
} from '../controllers/authController.js';
import { requireAuth } from '../middlewares/authMiddleware.js';
import { avatarUpload, limitUploadSize, AVATAR_MAX_BYTES } from '../middlewares/uploadMiddleware.js';

const router = express.Router();

router.post('/send-signup-otp', sendSignupOtp);
router.post('/register', register);
router.post('/send-forgot-password-otp', sendForgotPasswordOtp);
router.post('/reset-password', resetPassword);
router.post('/login', login);
router.post('/logout', logout);
router.get('/me', requireAuth, getMe);
router.get('/user/:username', getUserByUsername);
router.post('/send-email-update-otp', requireAuth, sendEmailUpdateOtp);
// Profile pictures: images only, 2 MB (this route used to accept 25 MB video).
router.put('/profile', requireAuth, limitUploadSize(AVATAR_MAX_BYTES, '2 MB'), avatarUpload.single('profilePic'), updateProfile);
router.delete('/account', requireAuth, deleteAccount);

export default router;
