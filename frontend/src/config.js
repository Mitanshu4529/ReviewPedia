/**
 * Single source of truth for where the backend lives.
 *
 * Every component used to compute its own fallback, and they disagreed: some
 * fell back to '' (same origin) and others to the hosted production server, so
 * in local development logins went to localhost while writes went to production.
 *
 *  - VITE_API_URL set          -> used for both REST and sockets
 *  - running on localhost      -> REST goes through the Vite proxy (''), sockets to :3001
 *  - anything else             -> the hosted backend
 */
const HOSTED_BACKEND = 'https://reviewpedia.onrender.com';

const isLocalhost = typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

const configured = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');

export const API_BASE_URL = configured || (isLocalhost ? '' : HOSTED_BACKEND);
export const SOCKET_BASE_URL = configured || (isLocalhost ? 'http://localhost:3001' : HOSTED_BACKEND);
