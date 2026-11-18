import mongoose from 'mongoose';

/**
 * Origins that may call the API with credentials.
 *
 *  - local dev servers
 *  - the production domain and its subdomains
 *  - FRONTEND_URL and every entry of ALLOWED_ORIGINS (comma separated)
 *  - *.vercel.app preview deployments, only when ALLOW_VERCEL_PREVIEWS=true
 *    (any Vercel-hosted site matches that suffix, so it is opt-in)
 */
const STATIC_ORIGINS = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'https://reviewpedia.co.in',
    'https://www.reviewpedia.co.in'
];

const configuredOrigins = () => [
    process.env.FRONTEND_URL,
    ...(process.env.ALLOWED_ORIGINS || '').split(',')
].map(o => (o || '').trim().replace(/\/+$/, '')).filter(Boolean);

export const isAllowedOrigin = (origin) => {
    // Same-origin requests and non-browser clients (curl, server-to-server) send no Origin.
    if (!origin) return true;
    if (STATIC_ORIGINS.includes(origin) || configuredOrigins().includes(origin)) return true;

    let hostname;
    try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'https:') return false;
        hostname = parsed.hostname;
    } catch {
        return false;
    }
    if (hostname.endsWith('.reviewpedia.co.in')) return true;
    if (process.env.ALLOW_VERCEL_PREVIEWS === 'true' && hostname.endsWith('.vercel.app')) return true;
    return false;
};

/** cors-style origin callback: disallowed origins simply get no CORS headers. */
export const corsOriginCallback = (origin, callback) => callback(null, isAllowedOrigin(origin));

export const isValidObjectId = (value) =>
    typeof value === 'string' && mongoose.Types.ObjectId.isValid(value) && /^[a-f0-9]{24}$/i.test(value);

/** Escapes a string so it can be embedded in a RegExp as a literal. */
export const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Usernames appear in URLs, chat lookups and emails, so new ones are limited to
 * 3-30 characters from letters, digits, dot, underscore and hyphen, starting and
 * ending with a letter or digit. Returns an error message, or null when valid.
 * Applied when a username is chosen (sign-up, rename) and never at login, so
 * accounts created before this rule keep working.
 */
export const USERNAME_RULE = 'Username must be 3-30 characters: letters, digits, dot, underscore or hyphen, starting and ending with a letter or digit';
export const validateUsername = (value) => {
    if (typeof value !== 'string') return 'Username is required';
    return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,28})[A-Za-z0-9]$/.test(value) ? null : USERNAME_RULE;
};

/** Builds an Error carrying an HTTP status for the central error handler. */
export const httpError = (status, message) => {
    const err = new Error(message);
    err.status = status;
    return err;
};

/** True if `url` points at this deployment's own Cloudinary account. */
export const isOwnCloudinaryUrl = (url) => {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    if (typeof url !== 'string' || !cloudName) return false;
    return url.startsWith(`https://res.cloudinary.com/${cloudName}/`) ||
        url.startsWith(`http://res.cloudinary.com/${cloudName}/`);
};
