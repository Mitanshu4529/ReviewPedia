import mongoose from 'mongoose';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import User from '../models/User.js';
import { cloudinaryInstance, MAX_MEDIA_LIMIT, STORAGE_LIMIT_MESSAGE } from '../middlewares/uploadMiddleware.js';
import { isValidObjectId, isOwnCloudinaryUrl } from '../utils/security.js';

const MAX_MESSAGE_LENGTH = 5000;
const MAX_CHAT_MEDIA_BYTES = 25 * 1024 * 1024; // matches the upload limit

// Loads a conversation and verifies the caller is one of its participants.
// Sends the error response itself and returns null when access is not allowed.
const loadConversationForUser = async (conversationId, userId, res) => {
    if (!isValidObjectId(conversationId)) {
        res.status(400).json({ error: { message: "Invalid conversation id" } });
        return null;
    }
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
        res.status(404).json({ error: { message: "Conversation not found" } });
        return null;
    }
    const isParticipant = conversation.participants.some(p => p.toString() === userId.toString());
    if (!isParticipant) {
        res.status(403).json({ error: { message: "You are not a participant of this conversation" } });
        return null;
    }
    return conversation;
};

// Get all conversations for a user with unread message counts
export const getConversations = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const rawConversations = await Conversation.find({ participants: userId })
            .populate('participants', 'username _id profilePic')
            .sort({ lastMessageAt: -1, updatedAt: -1 });

        const conversationIds = rawConversations.map(c => c._id);

        // Aggregate unread messages for each conversation where sender != current user
        const unreadCounts = await Message.aggregate([
            {
                $match: {
                    conversationId: { $in: conversationIds },
                    sender: { $ne: new mongoose.Types.ObjectId(userId) },
                    read: { $ne: true }
                }
            },
            {
                $group: {
                    _id: '$conversationId',
                    count: { $sum: 1 }
                }
            }
        ]);

        const unreadMap = {};
        unreadCounts.forEach(item => {
            unreadMap[item._id.toString()] = item.count;
        });

        const conversations = rawConversations.map(convo => {
            const doc = convo.toObject();
            doc.participants = (doc.participants || []).map(p => p || { username: 'Deleted User', profilePic: null });
            doc.unreadCount = unreadMap[doc._id.toString()] || 0;
            return doc;
        });

        res.json({ success: true, conversations });
    } catch (err) {
        next(err);
    }
};

// Get total unread count across all conversations for current user
export const getUnreadCount = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const userConversations = await Conversation.find({ participants: userId }).select('_id');
        const conversationIds = userConversations.map(c => c._id);

        const totalUnread = await Message.countDocuments({
            conversationId: { $in: conversationIds },
            sender: { $ne: userId },
            read: { $ne: true }
        });

        res.json({ success: true, unreadCount: totalUnread });
    } catch (err) {
        next(err);
    }
};

// Mark all messages in a conversation as read for the current user
export const markConversationAsRead = async (req, res, next) => {
    try {
        const { conversationId } = req.params;
        const userId = req.user.id;

        const conversation = await loadConversationForUser(conversationId, userId, res);
        if (!conversation) return;

        const updateResult = await Message.updateMany(
            {
                conversationId,
                sender: { $ne: userId },
                read: { $ne: true }
            },
            {
                $set: { read: true, readAt: new Date() }
            }
        );

        // Emit socket events to notify sender of read receipt and update unread counts
        const io = req.app.get('io');
        if (io) {
            const otherParticipant = conversation.participants.find(p => p.toString() !== userId.toString());
            if (otherParticipant) {
                io.to(otherParticipant.toString()).emit('messages_read', {
                    conversationId,
                    readerId: userId
                });
            }
            io.to(userId.toString()).emit('unread_count_update', { conversationId });
        }

        res.json({ success: true, markedCount: updateResult.modifiedCount });
    } catch (err) {
        next(err);
    }
};

// Create or fetch conversation with a specific user
export const createOrGetConversation = async (req, res, next) => {
    try {
        const { targetUsername } = req.body;
        const currentUserId = req.user.id;

        if (typeof targetUsername !== 'string' || !targetUsername.trim()) {
            return res.status(400).json({ error: { message: "targetUsername is required" } });
        }

        const targetUser = await User.findOne({ username: targetUsername.trim() });
        if (!targetUser) return res.status(404).json({ error: { message: "User not found" }});
        if (targetUser._id.toString() === currentUserId.toString()) {
            return res.status(400).json({ error: { message: "You cannot start a conversation with yourself" } });
        }

        // Check if conversation already exists (handles backwards compatibility with unsorted)
        let conversation = await Conversation.findOne({
            participants: { $all: [currentUserId, targetUser._id], $size: 2 }
        }).populate('participants', 'username _id profilePic');

        if (!conversation) {
            // To prevent race conditions (like React StrictMode sending 2 rapid requests),
            // we use an atomic findOneAndUpdate with an exact sorted array match and upsert.
            const p1 = currentUserId.toString();
            const p2 = targetUser._id.toString();
            const sortedParticipants = [p1, p2].sort();

            conversation = await Conversation.findOneAndUpdate(
                { participants: sortedParticipants },
                { 
                    $setOnInsert: { 
                        lastMessage: "Conversation started",
                        lastMessageAt: Date.now()
                    }
                },
                { new: true, upsert: true }
            );
            
            // Populate after upsert
            conversation = await Conversation.findById(conversation._id).populate('participants', 'username _id profilePic');
        }

        const doc = conversation.toObject();
        doc.participants = (doc.participants || []).map(p => p || { username: 'Deleted User', profilePic: null });

        res.json({ success: true, conversation: doc });
    } catch (err) {
        next(err);
    }
};

// Get messages for a specific conversation
export const getMessages = async (req, res, next) => {
    try {
        const { conversationId } = req.params;
        const userId = req.user.id;

        const conversation = await loadConversationForUser(conversationId, userId, res);
        if (!conversation) return;

        // Automatically mark unread messages from other user as read
        await Message.updateMany(
            {
                conversationId,
                sender: { $ne: userId },
                read: { $ne: true }
            },
            {
                $set: { read: true, readAt: new Date() }
            }
        );

        // Notify other participant of read receipt
        const io = req.app.get('io');
        if (io) {
            const otherParticipant = conversation.participants.find(p => p.toString() !== userId.toString());
            if (otherParticipant) {
                io.to(otherParticipant.toString()).emit('messages_read', {
                    conversationId,
                    readerId: userId
                });
            }
            io.to(userId.toString()).emit('unread_count_update', { conversationId });
        }

        const rawMessages = await Message.find({ conversationId })
            .populate('sender', 'username _id profilePic')
            .sort({ createdAt: 1 });

        const messages = rawMessages.map(msg => {
            const doc = msg.toObject();
            if (!doc.sender) {
                doc.sender = { username: 'Deleted User', profilePic: null };
            }
            return doc;
        });

        res.json({ success: true, messages });
    } catch (err) {
        next(err);
    }
};

// Upload media for chat
export const uploadChatMedia = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: { message: "No file uploaded" } });
        }

        const fileSize = req.file.size || req.file.bytes || 0;
        const userDoc = await User.findById(req.user.id);

        // checkUploadQuota already refused requests that could not fit before the
        // upload started; this is the exact check on the real size. A file that
        // still does not fit is removed again instead of being left orphaned.
        if (userDoc && (userDoc.totalMediaBytes || 0) + fileSize > MAX_MEDIA_LIMIT) {
            if (req.file.filename) {
                await cloudinaryInstance.uploader
                    .destroy(req.file.filename, { resource_type: req.file.mimetype?.startsWith('video/') ? 'video' : 'image' })
                    .catch(e => console.error('Cloudinary cleanup failed', e));
            }
            return res.status(400).json({ error: { message: STORAGE_LIMIT_MESSAGE } });
        }
        
        let mediaType = 'none';
        if (req.file.mimetype.startsWith('image/')) mediaType = 'image';
        else if (req.file.mimetype.startsWith('video/')) mediaType = 'video';

        res.json({ 
            success: true, 
            mediaUrl: req.file.path,
            mediaType,
            mediaSize: fileSize
        });
    } catch (err) {
        next(err);
    }
};

// Send a new message
export const sendMessage = async (req, res, next) => {
    try {
        const { conversationId, mediaType, location } = req.body || {};
        const senderId = req.user.id;

        // Only participants may post into a conversation.
        const conversation = await loadConversationForUser(conversationId, senderId, res);
        if (!conversation) return;

        const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
        if (text.length > MAX_MESSAGE_LENGTH) {
            return res.status(400).json({ error: { message: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)` } });
        }

        // Media must be a file uploaded to this app's own Cloudinary account, and
        // its size must be a sane positive number (a negative size would let a
        // client shrink its storage-quota counter).
        let mediaUrl = null;
        let mediaSize = 0;
        let safeMediaType = 'none';
        if (req.body.mediaUrl) {
            if (!isOwnCloudinaryUrl(req.body.mediaUrl)) {
                return res.status(400).json({ error: { message: "Invalid media URL" } });
            }
            if (mediaType !== 'image' && mediaType !== 'video') {
                return res.status(400).json({ error: { message: "Invalid media type" } });
            }
            const size = Number(req.body.mediaSize);
            if (!Number.isFinite(size) || size < 0 || size > MAX_CHAT_MEDIA_BYTES) {
                return res.status(400).json({ error: { message: "Invalid media size" } });
            }
            mediaUrl = req.body.mediaUrl;
            mediaSize = Math.round(size);
            safeMediaType = mediaType;
        }

        let safeLocation;
        if (location && typeof location === 'object') {
            const lat = Number(location.lat);
            const lng = Number(location.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                return res.status(400).json({ error: { message: "Invalid location" } });
            }
            safeLocation = { lat, lng, address: typeof location.address === 'string' ? location.address.slice(0, 300) : undefined };
            if (!mediaUrl) safeMediaType = 'location';
        }

        if (!text && !mediaUrl && !safeLocation) {
            return res.status(400).json({ error: { message: "Message is empty" } });
        }

        if (mediaSize) {
            // Conditional $inc: the quota check and the update are one atomic step,
            // so parallel messages cannot push the sender past the limit.
            const reserved = await User.findOneAndUpdate(
                { _id: senderId, $expr: { $lte: [{ $add: [{ $ifNull: ['$totalMediaBytes', 0] }, mediaSize] }, MAX_MEDIA_LIMIT] } },
                { $inc: { totalMediaBytes: mediaSize } }
            );
            if (!reserved) {
                return res.status(400).json({ error: { message: STORAGE_LIMIT_MESSAGE } });
            }
        }

        let message;
        try {
            message = await Message.create({
                conversationId,
                sender: senderId,
                text,
                mediaUrl,
                mediaType: safeMediaType,
                mediaSize,
                location: safeLocation
            });
        } catch (createErr) {
            if (mediaSize) {
                await User.findByIdAndUpdate(senderId, { $inc: { totalMediaBytes: -mediaSize } });
            }
            throw createErr;
        }

        // The recipient comes from the conversation, not from the request body.
        const receiverId = conversation.participants.find(p => p.toString() !== senderId.toString());

        const populatedMessage = await message.populate('sender', 'username _id profilePic');

        // Update the conversation's last message
        let lastMsgText = text;
        if (!text && mediaUrl) lastMsgText = `[Attached ${safeMediaType}]`;
        if (!text && !mediaUrl && safeLocation) lastMsgText = `[Shared Location]`;
        
        await Conversation.findByIdAndUpdate(conversationId, {
            lastMessage: lastMsgText,
            lastMessageAt: Date.now()
        });

        // Emit via socket.io to the receiver's room
        const io = req.app.get('io');
        if (io && receiverId) {
            io.to(receiverId.toString()).emit('receive_message', populatedMessage);
            io.to(receiverId.toString()).emit('unread_count_update', { conversationId });
        }

        res.json({ success: true, message: populatedMessage });
    } catch (err) {
        next(err);
    }
};

// Delete a conversation and all its messages + media
export const deleteConversation = async (req, res, next) => {
    try {
        const { conversationId } = req.params;
        const currentUserId = req.user.id;

        const conversation = await loadConversationForUser(conversationId, currentUserId, res);
        if (!conversation) return;

        // Find all messages in the conversation to delete media
        const messages = await Message.find({ conversationId });
        for (const msg of messages) {
            if (msg.mediaUrl) {
                if (msg.mediaSize && msg.sender) {
                    const userDoc = await User.findById(msg.sender);
                    if (userDoc) {
                        const newTotal = Math.max(0, (userDoc.totalMediaBytes || 0) - msg.mediaSize);
                        await User.findByIdAndUpdate(userDoc._id, { totalMediaBytes: newTotal });
                    }
                }
                try {
                    // Extract public ID from Cloudinary URL (assumes folder structure is present)
                    const parts = msg.mediaUrl.split('/');
                    const filename = parts.pop().split('.')[0];
                    const folder = parts.pop();
                    const publicId = `${folder}/${filename}`;
                    
                    await cloudinaryInstance.uploader.destroy(publicId, { 
                        resource_type: msg.mediaType === 'video' ? 'video' : 'image' 
                    });
                } catch (cloudinaryErr) {
                    console.error("Error deleting media from Cloudinary:", cloudinaryErr);
                }
            }
        }

        // Delete all messages
        await Message.deleteMany({ conversationId });

        // Delete the conversation itself
        await Conversation.findByIdAndDelete(conversationId);

        res.json({ success: true, message: "Conversation deleted successfully" });
    } catch (err) {
        next(err);
    }
};

// Delete a single message and its media
export const deleteMessage = async (req, res, next) => {
    try {
        const { messageId } = req.params;
        const currentUserId = req.user.id;

        if (!isValidObjectId(messageId)) {
            return res.status(400).json({ error: { message: "Invalid message id" } });
        }

        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ error: { message: "Message not found" } });

        // Ensure user is the sender of the message
        if (message.sender.toString() !== currentUserId) {
            return res.status(403).json({ error: { message: "Not authorized to delete this message" } });
        }

        // Delete from Cloudinary if media exists
        if (message.mediaUrl) {
            if (message.mediaSize) {
                const userDoc = await User.findById(message.sender);
                if (userDoc) {
                    const newTotal = Math.max(0, (userDoc.totalMediaBytes || 0) - message.mediaSize);
                    await User.findByIdAndUpdate(userDoc._id, { totalMediaBytes: newTotal });
                }
            }
            try {
                const parts = message.mediaUrl.split('/');
                const filename = parts.pop().split('.')[0];
                const folder = parts.pop();
                const publicId = `${folder}/${filename}`;
                
                await cloudinaryInstance.uploader.destroy(publicId, { 
                    resource_type: message.mediaType === 'video' ? 'video' : 'image' 
                });
            } catch (cloudinaryErr) {
                console.error("Error deleting message media from Cloudinary:", cloudinaryErr);
            }
        }

        const conversationId = message.conversationId;

        // Delete message document
        await Message.findByIdAndDelete(messageId);

        // Fetch the new last message for the conversation
        const remainingMessages = await Message.find({ conversationId })
            .sort({ createdAt: -1 })
            .limit(1);

        let newLastMessage = "Conversation started";
        if (remainingMessages.length > 0) {
            const lastMsg = remainingMessages[0];
            newLastMessage = lastMsg.text || `[Attached ${lastMsg.mediaType}]`;
        }

        await Conversation.findByIdAndUpdate(conversationId, {
            lastMessage: newLastMessage,
            lastMessageAt: remainingMessages.length > 0 ? remainingMessages[0].createdAt : Date.now()
        });

        // Emit via socket to inform other client
        const conversation = await Conversation.findById(conversationId);
        const receiverId = conversation?.participants.find(p => p.toString() !== currentUserId);

        const io = req.app.get('io');
        if (io && receiverId) {
            io.to(receiverId.toString()).emit('message_deleted', { messageId, conversationId });
        }

        res.json({ success: true, message: "Message deleted successfully", conversationId, newLastMessage });
    } catch (err) {
        next(err);
    }
};
