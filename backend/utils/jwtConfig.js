/**
 * Centralized JWT configuration and Secret retrieval.
 *
 * A hardcoded fallback secret is public knowledge (it is in the repository), so
 * anyone could forge tokens for a server running with it. The fallback is
 * therefore limited to automated tests and to an explicitly local development
 * run; any hosted or production environment must set JWT_SECRET.
 */
const DEV_FALLBACK_SECRET = 'reviewpedia_default_jwt_secret_key_dev_2026';
let warned = false;

export const getJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  const env = process.env.NODE_ENV;
  const isHosted = !!process.env.RENDER || !!process.env.VERCEL;
  if (!isHosted && (env === 'test' || env === 'development')) {
    if (!warned && env !== 'test') {
      console.warn('⚠️ WARNING: JWT_SECRET environment variable is missing. Using development fallback secret.');
      warned = true;
    }
    return DEV_FALLBACK_SECRET;
  }

  throw new Error('FATAL: JWT_SECRET environment variable is required (set NODE_ENV=development to use the local fallback).');
};
