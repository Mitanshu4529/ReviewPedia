import User from '../models/User.js';
import Review from '../models/Review.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Comment from '../models/Comment.js';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../utils/jwtConfig.js';
import ChatUpload from '../models/ChatUpload.js';
import { validateUsername, isOwnCloudinaryUrl } from '../utils/security.js';
import { cloudinaryInstance, releaseMediaBytes } from '../middlewares/uploadMiddleware.js';

/** "<folder>/<file>" public ID of a file in this app's own Cloudinary account, else null. */
const publicIdFromUrl = (url) => {
    if (!isOwnCloudinaryUrl(url)) return null;
    const parts = url.split('?')[0].split('/');
    const filename = (parts.pop() || '').split('.')[0];
    const folder = parts.pop();
    return folder && filename ? `${folder}/${filename}` : null;
};

/**
 * Signs a 7-day session token for `user`. `tv` is the account's tokenVersion;
 * requireAuth refuses tokens whose version is older than the account's.
 */
export const issueSession = (user) => {
    const publicUser = {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        profilePic: user.profilePic,
        totalMediaBytes: user.totalMediaBytes || 0
    };
    const token = jwt.sign({ ...publicUser, tv: user.tokenVersion || 0 }, getJwtSecret(), { expiresIn: '7d' });
    return { token, user: publicUser };
};

// Usernames are unique ignoring case, so "Alice" cannot be registered next to "alice".
const CASE_INSENSITIVE = { locale: 'en', strength: 2 };
export const findUserByUsername = (username) =>
    User.findOne({ username }).collation(CASE_INSENSITIVE);

export const registerUser = async (data) => {
    const { username, email, password } = data;

    if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
        throw new Error('Username, email and password are required');
    }

    const usernameError = validateUsername(username);
    if (usernameError) throw new Error(usernameError);

    const existingUser = await User.findOne({ email }) || await findUserByUsername(username);
    if (existingUser) {
        throw new Error('User already exists with this email or username');
    }

    const newUser = new User({ username, email, password });
    await newUser.save();

    return issueSession(newUser);
};

export const loginUser = async (email, password) => {
    // Type check first: an object such as {"$ne": null} would otherwise be passed
    // straight into the query and match an arbitrary account.
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
        throw new Error('Invalid credentials');
    }
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
        throw new Error('Invalid credentials');
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        throw new Error('Invalid credentials');
    }

    return issueSession(user);
};

export const updateProfile = async (userId, data) => {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    const oldUsername = user.username;
    if (data.username !== undefined && typeof data.username !== 'string') {
        throw new Error('Invalid username');
    }
    if (data.email !== undefined && typeof data.email !== 'string') {
        throw new Error('Invalid email');
    }
    if (data.username && data.username !== user.username) {
        // Validated only when the name actually changes: an account whose existing
        // name predates the rule can still update its email or picture.
        const usernameError = validateUsername(data.username);
        if (usernameError) throw new Error(usernameError);
        const existingUsername = await findUserByUsername(data.username);
        if (existingUsername && existingUsername._id.toString() !== user._id.toString()) throw new Error('Username already taken');
        user.username = data.username;

        // Cascade username update to user's existing reviews
        // Match on the account id only: matching on the old name would also rename
        // imported reviews written by a different person with the same name.
        await Review.updateMany(
            { 'user.id': user._id },
            { $set: { 'user.name': data.username } }
        );
        await Comment.updateMany(
            { 'user.id': user._id },
            { $set: { 'user.name': data.username } }
        );
    }

    if (data.email && data.email !== user.email) {
        const existingEmail = await User.findOne({ email: data.email });
        if (existingEmail) throw new Error('Email already taken');
        user.email = data.email;
    }

    if (data.profilePic) {
        user.profilePic = data.profilePic;
    }

    await user.save();

    return issueSession(user);
};

export const deleteAccount = async (userId, confirmEmail) => {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    if (!confirmEmail || confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
        throw new Error('Email address does not match');
    }

    // Files to remove from Cloudinary once the records are gone.
    const filesToDestroy = [];

    // Delete user's reviews together with the comments under them, and the
    // comments the user wrote elsewhere, so nothing is left orphaned.
    const ownReviews = await Review.find({ 'user.id': user._id }).select('_id review.media');
    const ownReviewIds = ownReviews.map(r => r._id);
    for (const r of ownReviews) {
        for (const m of r.review?.media || []) {
            const publicId = publicIdFromUrl(m.url);
            if (publicId) filesToDestroy.push({ publicId, type: m.type });
        }
    }
    await Comment.deleteMany({ $or: [{ reviewId: { $in: ownReviewIds } }, { 'user.id': user._id }] });
    await Review.deleteMany({ _id: { $in: ownReviewIds } });

    // Delete conversations and messages associated with this user. Media sent by
    // the other participant in those conversations is removed too, and its bytes
    // are given back to that participant's quota.
    const userConvos = await Conversation.find({ participants: userId });
    const userConvoIds = userConvos.map(c => c._id);
    if (userConvoIds.length > 0) {
        const mediaMessages = await Message.find({
            conversationId: { $in: userConvoIds },
            mediaUrl: { $ne: null }
        }).select('sender mediaUrl mediaType mediaSize mediaPublicId');
        for (const msg of mediaMessages) {
            if (msg.sender && msg.sender.toString() !== user._id.toString() && msg.mediaSize) {
                await releaseMediaBytes(msg.sender, msg.mediaSize);
            }
            const publicId = msg.mediaPublicId || publicIdFromUrl(msg.mediaUrl);
            if (publicId) filesToDestroy.push({ publicId, type: msg.mediaType });
        }
        await ChatUpload.deleteMany({ attachedTo: { $in: mediaMessages.map(m => m._id) } });
        await Message.deleteMany({
            $or: [{ conversationId: { $in: userConvoIds } }, { sender: userId }]
        });
        await Conversation.deleteMany({ participants: userId });
    }

    // Chat uploads the user made but never sent.
    const unsent = await ChatUpload.find({ owner: user._id, attachedTo: null });
    for (const u of unsent) filesToDestroy.push({ publicId: u.publicId, type: u.mediaType });
    await ChatUpload.deleteMany({ owner: user._id });

    const avatarId = publicIdFromUrl(user.profilePic);
    if (avatarId) filesToDestroy.push({ publicId: avatarId, type: 'image' });

    // Delete user document
    await User.findByIdAndDelete(userId);

    // Storage clean-up never fails the deletion itself.
    await Promise.all(filesToDestroy.map(f =>
        cloudinaryInstance.uploader
            .destroy(f.publicId, { resource_type: f.type === 'video' ? 'video' : 'image' })
            .catch(e => console.error('Could not remove a file of a deleted account:', e.message))
    ));

    return { success: true, message: 'Account deleted successfully' };
};

export const resetUserPassword = async (email, newPassword) => {
    const cleanEmail = (email || '').trim().toLowerCase();
    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
        throw new Error('No account found with this email address');
    }

    if (!newPassword || newPassword.length < 6) {
        throw new Error('Password must be at least 6 characters long');
    }

    user.password = newPassword;
    // Ends every session that existed before the reset (for example a stolen one).
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return issueSession(user);
};
