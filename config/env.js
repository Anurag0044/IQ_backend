const logger = require('../utils/logger');

const isProduction = process.env.NODE_ENV === 'production';

function clean(value) {
  return String(value || '').trim();
}

function stripTrailingSlash(value) {
  return clean(value).replace(/\/+$/, '');
}

function splitOrigins(value) {
  return clean(value)
    .split(',')
    .map(stripTrailingSlash)
    .filter(Boolean);
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || (!isProduction && parsed.protocol === 'http:');
  } catch {
    return false;
  }
}

function isLocalhostUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function getFrontendUrl() {
  return splitOrigins(process.env.FRONTEND_URL)[0] || '';
}

function getBackendUrl() {
  return stripTrailingSlash(process.env.BACKEND_URL);
}

function getAllowedOrigins() {
  return Array.from(new Set([
    ...splitOrigins(process.env.FRONTEND_URL),
    ...splitOrigins(process.env.CORS_ALLOWED_ORIGINS),
  ]));
}

function corsOrigin(origin, callback) {
  const allowedOrigins = getAllowedOrigins();

  if (!origin) {
    return callback(null, true);
  }

  const normalizedOrigin = stripTrailingSlash(origin);
  if (allowedOrigins.includes(normalizedOrigin)) {
    return callback(null, true);
  }

  if (!isProduction && allowedOrigins.length === 0) {
    return callback(null, true);
  }

  return callback(new Error('Origin is not allowed by CloudIQ CORS policy.'));
}

function joinUrl(origin, path) {
  const base = stripTrailingSlash(origin);
  if (!base) return '';
  return `${base}${String(path || '').startsWith('/') ? path : `/${path}`}`;
}

const requiredProductionEnv = [
  'NODE_ENV',
  'PORT',
  'FRONTEND_URL',
  'BACKEND_URL',
  'SESSION_SECRET',
  'CLOUDANT_APIKEY',
  'CLOUDANT_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_DATABASE_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'LAB_TOKEN_ENCRYPTION_KEY',
  'APPID_TENANT_ID',
  'APPID_CLIENT_ID',
  'APPID_SECRET',
  'APPID_OAUTH_SERVER_URL',
  'APPID_REDIRECT_URI',
  'ORION_API_KEY',
];

function validateEnvironment() {
  const missing = requiredProductionEnv.filter((name) => !clean(process.env[name]));
  const callbackUrls = [
    clean(process.env.APPID_REDIRECT_URI),
    clean(process.env.GITHUB_CALLBACK_URL),
  ].filter(Boolean);
  const configuredUrls = Array.from(new Set([
    ...getAllowedOrigins(),
    getBackendUrl(),
    ...callbackUrls,
  ].filter(Boolean)));
  const invalidUrls = configuredUrls.filter((url) => !isValidUrl(url));
  const localhostUrls = isProduction
    ? configuredUrls.filter((url) => isLocalhostUrl(url))
    : [];
  const trailingSlashCallbacks = callbackUrls.filter((url) => /\/$/.test(url));

  if (missing.length > 0) {
    const message = `[ENV] Missing required production environment variable(s): ${missing.join(', ')}`;
    if (isProduction) {
      logger.error(message);
      process.exit(1);
    }
    logger.warn(message);
  }

  if (invalidUrls.length > 0) {
    const message = `[ENV] Invalid URL configuration: ${invalidUrls.join(', ')}`;
    if (isProduction) {
      logger.error(message);
      process.exit(1);
    }
    logger.warn(message);
  }

  if (localhostUrls.length > 0) {
    const message = `[ENV] Production URL configuration must not use localhost: ${localhostUrls.join(', ')}`;
    logger.error(message);
    process.exit(1);
  }

  if (trailingSlashCallbacks.length > 0) {
    logger.warn(`[ENV] OAuth callback URL(s) include a trailing slash. Provider dashboard values must match exactly: ${trailingSlashCallbacks.join(', ')}`);
  }

  if (isProduction && process.env.SESSION_SECRET === 'cloudiq-fallback-secret') {
    logger.error('[ENV] SESSION_SECRET must be a strong deployment secret in production.');
    process.exit(1);
  }
}

module.exports = {
  corsOrigin,
  getAllowedOrigins,
  getBackendUrl,
  getFrontendUrl,
  isProduction,
  joinUrl,
  validateEnvironment,
};
