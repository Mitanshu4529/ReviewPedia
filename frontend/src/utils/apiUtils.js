/**
 * Auth Token & Header Utilities
 * Provides unified, cross-device JWT token management and request header generation.
 */

const TOKEN_KEY = 'reviewpedia_auth_token';

/**
 * Get JWT token from localStorage (with backward compatibility check)
 */
export const getAuthToken = () => {
    try {
        if (typeof window === 'undefined') return null;
        return localStorage.getItem(TOKEN_KEY) || localStorage.getItem('token') || null;
    } catch {
        return null;
    }
};

/**
 * Save JWT token to localStorage
 */
export const setAuthToken = (token) => {
    try {
        if (typeof window === 'undefined' || !token) return;
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem('token', token); // Keep legacy key in sync
    } catch (e) {
        console.warn('Could not save auth token to localStorage:', e);
    }
};

/**
 * Remove JWT token from localStorage
 */
export const removeAuthToken = () => {
    try {
        if (typeof window === 'undefined') return;
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('token');
    } catch (e) {
        console.warn('Could not remove auth token from localStorage:', e);
    }
};

/**
 * Returns Authorization header object if token exists
 * Example: { 'Authorization': 'Bearer <token>' }
 */
export const getAuthHeaders = () => {
    const token = getAuthToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
};

/**
 * Returns combined JSON Content-Type + Authorization headers
 */
export const getJsonAuthHeaders = () => {
    return {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
    };
};

/**
 * Turns an API error body into readable text. The backend answers either
 * { error: 'text' } or { error: { message: 'text' } } (the central error
 * handler), so passing `data.error` straight to a notice could show
 * "[object Object]".
 */
export const errorMessage = (data, fallback = 'Something went wrong. Please try again.') => {
    const err = data?.error ?? data?.message;
    if (typeof err === 'string' && err.trim()) return err;
    if (err && typeof err.message === 'string' && err.message.trim()) return err.message;
    return fallback;
};

/** res.json() that never throws (an HTML error page or empty body becomes {}). */
export const readJson = (res) => res.json().catch(() => ({}));

// Requests whose 401 means "wrong credentials", not "session ended".
const CREDENTIAL_PATHS = ['/api/auth/login', '/api/auth/register', '/api/auth/reset-password'];

/**
 * Calls `onExpired` once whenever an authenticated API request comes back 401,
 * i.e. the stored session has expired or was ended (password reset, account
 * deleted). Without this the page kept looking signed in while every action
 * failed. Returns a function that removes the watcher.
 */
export const watchSessionExpiry = (onExpired) => {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return () => {};
    const originalFetch = window.fetch;
    const watchedFetch = async (input, init) => {
        const res = await originalFetch(input, init);
        try {
            if (res.status === 401) {
                const url = typeof input === 'string' ? input : input?.url || '';
                const isApi = url.includes('/api/');
                const isCredentialCall = CREDENTIAL_PATHS.some(p => url.includes(p));
                if (isApi && !isCredentialCall && getAuthToken()) onExpired();
            }
        } catch {
            // never let the watcher break a request
        }
        return res;
    };
    window.fetch = watchedFetch;
    return () => {
        if (window.fetch === watchedFetch) window.fetch = originalFetch;
    };
};
