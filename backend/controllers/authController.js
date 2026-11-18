import * as authService from '../services/authService.js';
import User from '../models/User.js';
import EmailOtp from '../models/EmailOtp.js';
import Review from '../models/Review.js';
import { generateOtp, sendOtpEmail } from '../services/emailService.js';
import { validateUsername, isOwnCloudinaryUrl } from '../utils/security.js';
import { cloudinaryInstance } from '../middlewares/uploadMiddleware.js';
import crypto from 'crypto';

const MAX_OTP_ATTEMPTS = 5;

const OTP_ERRORS = {
    missing: 'Verification code expired or not found. Please request a new code.',
    locked: 'Too many incorrect attempts. Please request a new code.'
};

const sameCode = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Stores the code for an address and purpose, replacing any earlier one.
 *
 * Two requests arriving together can both try to insert; the unique index lets
 * only one through and the other gets a duplicate-key error, so it is retried
 * as an update. Either way exactly one record (the latest code) remains.
 */
const saveOtp = async (email, purpose, otp) => {
    const write = () => EmailOtp.findOneAndUpdate(
        { email, purpose },
        { otp, attempts: 0, createdAt: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    try {
        return await write();
    } catch (err) {
        if (err?.code !== 11000) throw err;
        return write();
    }
};

/**
 * Checks a one-time code and uses it up. Returns null on success or an error key
 * ('missing' | 'locked' | 'invalid').
 *
 * Every call first claims one of the MAX_OTP_ATTEMPTS attempts with a single
 * conditional update, and only a call that got an attempt is allowed to compare
 * the code. The old read-compare-save sequence let parallel requests all read
 * "attempts: 0" and each try a different code.
 */
const consumeOtp = async (email, purpose, code) => {
    const record = await EmailOtp.findOneAndUpdate(
        { email, purpose, attempts: { $lt: MAX_OTP_ATTEMPTS } },
        { $inc: { attempts: 1 } },
        { new: true }
    );
    if (!record) {
        // Either there is no code, or its attempts are used up: remove it so a new one must be requested.
        const removed = await EmailOtp.deleteMany({ email, purpose });
        return removed.deletedCount > 0 ? 'locked' : 'missing';
    }
    if (!sameCode(record.otp, code)) return 'invalid';

    // Correct: delete it so it cannot be reused. If a parallel request with the
    // same correct code already deleted it, this one must not succeed as well.
    const claimed = await EmailOtp.deleteOne({ _id: record._id });
    return claimed.deletedCount === 1 ? null : 'missing';
};

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

const getCookieOptions = () => ({
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
});

// Send 6-digit OTP for signup verification
export const sendSignupOtp = async (req, res) => {
    try {
        const { email, username } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, error: 'A valid email address is required' });
        }
        if (typeof email !== 'string') {
            return res.status(400).json({ success: false, error: 'A valid email address is required' });
        }
        const cleanUsername = typeof username === 'string' ? username.trim() : username;
        const usernameError = validateUsername(cleanUsername);
        if (usernameError) {
            return res.status(400).json({ success: false, error: usernameError });
        }

        const cleanEmail = email.trim().toLowerCase();

        // Check if email already registered
        const existingEmail = await User.findOne({ email: cleanEmail });
        if (existingEmail) {
            return res.status(400).json({ success: false, error: 'An account with this email already exists' });
        }

        // Check if username already taken
        const existingUsername = await authService.findUserByUsername(cleanUsername);
        if (existingUsername) {
            return res.status(400).json({ success: false, error: 'Username is already taken' });
        }

        const otp = generateOtp();

        // Save or update OTP record
        await saveOtp(cleanEmail, 'signup', otp);

        // Send OTP email
        await sendOtpEmail({
            to: cleanEmail,
            otp,
            purpose: 'signup',
            username: cleanUsername
        });

        res.status(200).json({
            success: true,
            message: `Verification code sent to ${cleanEmail}`
        });
    } catch (error) {
        console.error('Error in sendSignupOtp:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to send verification code' });
    }
};

// Send 6-digit OTP for email address change
export const sendEmailUpdateOtp = async (req, res) => {
    try {
        const { newEmail } = req.body;
        if (!newEmail || !newEmail.includes('@')) {
            return res.status(400).json({ success: false, error: 'A valid new email address is required' });
        }

        const cleanNewEmail = newEmail.trim().toLowerCase();
        const currentUser = await User.findById(req.user.id);
        if (!currentUser) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (currentUser.email.toLowerCase() === cleanNewEmail) {
            return res.status(400).json({ success: false, error: 'This is already your current email address' });
        }

        // Check if new email is taken by someone else
        const existingUser = await User.findOne({ email: cleanNewEmail });
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'This email is already in use by another account' });
        }

        const otp = generateOtp();

        // Save or update OTP record
        await saveOtp(cleanNewEmail, 'email_update', otp);

        // Send OTP to the new email address
        await sendOtpEmail({
            to: cleanNewEmail,
            otp,
            purpose: 'email_update',
            username: currentUser.username
        });

        res.status(200).json({
            success: true,
            message: `Verification code sent to ${cleanNewEmail}`
        });
    } catch (error) {
        console.error('Error in sendEmailUpdateOtp:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to send verification code' });
    }
};

export const register = async (req, res) => {
    try {
        const { username, email, password, otp } = req.body;
        if (!otp) {
            return res.status(400).json({ success: false, error: 'Email verification code is required' });
        }

        if (typeof email !== 'string' || typeof password !== 'string' || typeof username !== 'string') {
            return res.status(400).json({ success: false, error: 'Username, email and password are required' });
        }
        // Checked before the code is used up, so a rejected username does not cost the code.
        const cleanUsername = username.trim();
        const usernameError = validateUsername(cleanUsername);
        if (usernameError) {
            return res.status(400).json({ success: false, error: usernameError });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
        }

        const cleanEmail = email.trim().toLowerCase();
        const cleanOtp = otp.toString().trim();

        const otpError = await consumeOtp(cleanEmail, 'signup', cleanOtp);
        if (otpError) {
            return res.status(400).json({ success: false, error: OTP_ERRORS[otpError] || 'Invalid verification code. Please check your email and try again.' });
        }

        const { token, user } = await authService.registerUser({ username: cleanUsername, email: cleanEmail, password });

        res.cookie('token', token, getCookieOptions());

        res.status(201).json({ success: true, token, user });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const { token, user } = await authService.loginUser(email, password);

        res.cookie('token', token, getCookieOptions());

        res.status(200).json({ success: true, token, user });
    } catch (error) {
        res.status(401).json({ success: false, error: error.message });
    }
};

export const logout = (req, res) => {
    res.clearCookie('token', {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax'
    });
    res.status(200).json({ success: true, message: 'Logged out successfully' });
};

export const getMe = async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const user = await User.findById(req.user.id).select('-password');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.status(200).json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const updateProfile = async (req, res) => {
    try {
        // Only these fields are taken from the client. (The whole body used to be
        // passed on, so a `profilePic` text field could point the avatar at any URL.)
        const body = req.body || {};
        const updateData = {};
        for (const field of ['username', 'email', 'otp']) {
            if (body[field] !== undefined) updateData[field] = body[field];
        }
        if (req.file) {
            updateData.profilePic = req.file.path;
        }
        if (updateData.username !== undefined && typeof updateData.username !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid username' });
        }
        if (updateData.email !== undefined && typeof updateData.email !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid email' });
        }
        if (typeof updateData.username === 'string') updateData.username = updateData.username.trim();

        const currentUser = await User.findById(req.user.id);
        if (!currentUser) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // If email is being changed, verify the OTP sent to the new email
        if (updateData.email && updateData.email.trim().toLowerCase() !== currentUser.email.toLowerCase()) {
            const cleanNewEmail = updateData.email.trim().toLowerCase();
            const cleanOtp = (updateData.otp || '').toString().trim();

            if (!cleanOtp) {
                return res.status(400).json({ success: false, error: 'Verification code is required to update your email address' });
            }

            const otpError = await consumeOtp(cleanNewEmail, 'email_update', cleanOtp);
            if (otpError) {
                return res.status(400).json({ success: false, error: OTP_ERRORS[otpError] || 'Invalid verification code. Please try again.' });
            }
        }

        const previousPic = currentUser.profilePic;
        const { token, user } = await authService.updateProfile(req.user.id, updateData);

        // A new picture replaced the old one: remove the old file from storage so
        // it is not kept forever. Only files in this app's own Cloudinary account
        // are touched, and a failure here never fails the profile update.
        if (req.file && previousPic && previousPic !== user.profilePic && isOwnCloudinaryUrl(previousPic)) {
            const parts = previousPic.split('?')[0].split('/');
            const filename = parts.pop().split('.')[0];
            const folder = parts.pop();
            cloudinaryInstance.uploader
                .destroy(`${folder}/${filename}`, { resource_type: 'image' })
                .catch(e => console.error('Could not remove the previous profile picture:', e.message));
        }

        res.cookie('token', token, getCookieOptions());

        res.status(200).json({ success: true, token, user });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

export const getUserByUsername = async (req, res) => {
    try {
        // Public profile: never expose the email address here.
        const user = await User.findOne({ username: req.params.username }).select('username profilePic createdAt');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Real activity for the profile card (it used to show invented numbers).
        const [reviewCount, recent] = await Promise.all([
            Review.countDocuments({ 'user.id': user._id }),
            Review.find({ 'user.id': user._id })
                .sort({ _id: -1 })
                .limit(3)
                .select('product.name product.category review.text review.rating location.city')
                .lean()
        ]);
        const recentReviews = recent.map(r => ({
            id: r._id.toString(),
            productName: r.product?.name || '',
            category: r.product?.category || '',
            rating: r.review?.rating ?? null,
            text: (r.review?.text || '').slice(0, 200),
            city: r.location?.city || ''
        }));

        res.status(200).json({ success: true, user, reviewCount, recentReviews });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

export const deleteAccount = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email confirmation is required' });
        }
        await authService.deleteAccount(req.user.id, email);
        res.clearCookie('token', {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? 'none' : 'lax'
        });
        res.status(200).json({ success: true, message: 'Account deleted successfully' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
};

// Send 6-digit OTP for Forgot Password
export const sendForgotPasswordOtp = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, error: 'A valid email address is required' });
        }

        const cleanEmail = email.trim().toLowerCase();

        // Same answer whether or not the address is registered: a different
        // response for unknown emails lets anyone test which emails have accounts.
        const existingUser = await User.findOne({ email: cleanEmail });
        if (!existingUser) {
            return res.status(200).json({
                success: true,
                message: 'If an account exists for this email, a password reset code has been sent.'
            });
        }

        const otp = generateOtp();

        // Save or update OTP record
        await saveOtp(cleanEmail, 'forgot_password', otp);

        // Send OTP email
        await sendOtpEmail({
            to: cleanEmail,
            otp,
            purpose: 'forgot_password',
            username: existingUser.username
        });

        res.status(200).json({
            success: true,
            message: `Password reset code sent to ${cleanEmail}`
        });
    } catch (error) {
        console.error('Error in sendForgotPasswordOtp:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to send password reset code' });
    }
};

// Reset Password with OTP verification
export const resetPassword = async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, error: 'A valid email address is required' });
        }
        if (!otp) {
            return res.status(400).json({ success: false, error: 'Verification code is required' });
        }
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'New password must be at least 6 characters long' });
        }

        const cleanEmail = email.trim().toLowerCase();
        const cleanOtp = otp.toString().trim();

        const otpError = await consumeOtp(cleanEmail, 'forgot_password', cleanOtp);
        if (otpError) {
            return res.status(400).json({ success: false, error: OTP_ERRORS[otpError] || 'Invalid verification code. Please check your email and try again.' });
        }

        // Reset user password and generate new token
        const { token, user } = await authService.resetUserPassword(cleanEmail, newPassword);

        res.cookie('token', token, getCookieOptions());

        res.status(200).json({
            success: true,
            token,
            user,
            message: 'Password reset successfully'
        });
    } catch (error) {
        console.error('Error in resetPassword:', error);
        res.status(400).json({ success: false, error: error.message || 'Failed to reset password' });
    }
};
