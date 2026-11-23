import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import reviewRoutes from './routes/reviewRoutes.js';
import agentRoutes from './routes/agentRoutes.js';
import authRoutes from './routes/authRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { corsOriginCallback, isAllowedOrigin } from './utils/security.js';
import cookieParser from 'cookie-parser';

const app = express();

// Behind a reverse proxy (Render, Vercel) the client address is in X-Forwarded-For.
// Without this every visitor shares the proxy's IP and therefore one rate-limit bucket.
app.set('trust proxy', 1);

// Security Headers with Helmet
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false
}));

const isTest = process.env.NODE_ENV === 'test';

// Rate Limiting
// Applied only to credential / OTP endpoints. Session checks such as GET /auth/me
// run on every page load and must not be able to lock a user out.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Limit each IP to 50 auth attempts per windowMs
    message: { success: false, error: 'Too many authentication attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest
});
const AUTH_LIMITED_PATHS = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/send-signup-otp',
    '/api/auth/send-forgot-password-otp',
    '/api/auth/send-email-update-otp',
    '/api/auth/reset-password'
];

const agentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // Limit each IP to 30 agent trigger requests per windowMs
    message: { success: false, error: 'Too many agent execution requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest
});

// Global Middlewares
app.use(cors({
    origin: corsOriginCallback,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
// CSRF guard. The session cookie is SameSite=None in production, so a page on
// another site could otherwise submit a form (a "simple" request that CORS does
// not block) and act as the signed-in visitor. Browsers always send Origin on
// cross-site POST/PUT/PATCH/DELETE, so those are refused unless the origin is
// one of ours. Requests without Origin (curl, server-to-server) are unaffected.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use('/api', (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    // isAllowedOrigin: no Origin → allowed; the opaque origin "null" → refused.
    if (isAllowedOrigin(req.headers.origin)) return next();
    return res.status(403).json({ success: false, error: { message: 'Cross-site request refused' } });
});

app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// Health Check Endpoint
app.get('/api/health', (req, res) => {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: dbStatus,
        version: '1.0.0'
    });
});

// Routes
app.use(AUTH_LIMITED_PATHS, authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/reviews', reviewRoutes);
// One limiter in front of every agent route, including the public summary.
app.use('/api/agents', agentLimiter, agentRoutes);
app.use('/api/chat', chatRoutes);

// Unknown API routes
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: { message: 'Not found' } });
});

// Centralized error handler
app.use(errorHandler);

export default app;
