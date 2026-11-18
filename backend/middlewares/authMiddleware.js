import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { getJwtSecret } from '../utils/jwtConfig.js';

export const requireAuth = async (req, res, next) => {
    // Check cookies for token, or Authorization header as fallback
    let token = req.cookies?.token;

    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, getJwtSecret());
    } catch (ex) {
        return res.status(401).json({ success: false, error: 'Invalid token.' });
    }

    // The token is valid for 7 days, but the account behind it may have been
    // deleted since it was issued. Role is read from the database as well, so a
    // role change takes effect immediately instead of when the token expires.
    try {
        if (!decoded?.id || !mongoose.Types.ObjectId.isValid(String(decoded.id))) {
            return res.status(401).json({ success: false, error: 'Invalid token.' });
        }
        const account = await User.findById(decoded.id).select('username role').lean();
        if (!account) {
            return res.status(401).json({ success: false, error: 'Account no longer exists.' });
        }
        req.user = { ...decoded, id: String(decoded.id), username: account.username, role: account.role };
        next();
    } catch (err) {
        next(err);
    }
};

/**
 * Allows only accounts with one of the given roles. Use after requireAuth,
 * which reads the role from the database on every request, so granting or
 * removing a role takes effect immediately.
 */
export const requireRole = (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({
            success: false,
            error: `This action needs ${roles.length === 1 ? `an ${roles[0]} account` : `one of these roles: ${roles.join(', ')}`}.`
        });
    }
    next();
};
