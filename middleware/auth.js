// ============================================
// CloudIQ Backend - Authentication Middleware
// ============================================
// Protects routes by verifying user authentication status.
// Provides helper to extract consistent user info from App ID session.

/**
 * Extracts a consistent user identity object from the Passport session.
 * This is the SINGLE SOURCE OF TRUTH for who the user is.
 * All routes should use this instead of manually parsing req.user.
 *
 * @param {Object} reqUser - The raw req.user from Passport/App ID
 * @returns {{ userId: string, email: string, username: string }}
 */
function extractUserInfo(reqUser) {
  if (!reqUser) return { userId: null, email: null, username: 'Anonymous' };

  const email = reqUser.email || (reqUser.emails && reqUser.emails[0]?.value) || null;
  let userId = reqUser.sub || email;

  // Try to get sub from identity token (most reliable)
  if (reqUser.identityToken) {
    try {
      const payload = JSON.parse(
        Buffer.from(reqUser.identityToken.split('.')[1], 'base64').toString()
      );
      userId = payload.sub || userId;
    } catch (e) {
      // ignore decode errors
    }
  }

  const username = reqUser.name || reqUser.given_name || (email ? email.split('@')[0] : 'Anonymous');

  return { userId, email, username };
}

/**
 * Middleware: Ensures the user is authenticated.
 * Returns 401 JSON for API requests, redirects for browser requests.
 */
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'You must be logged in to access this resource.',
    });
  }

  return res.redirect('/auth/login');
}

/**
 * Middleware: Ensures the user has admin role.
 * Must be used AFTER ensureAuthenticated.
 */
function ensureAdmin(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'You must be logged in to access this resource.',
    });
  }

  const isAdmin = checkAdminRole(req.user);
  if (isAdmin) return next();

  const { username } = extractUserInfo(req.user);
  console.warn(`[AUTH] Admin access denied for user: ${username}`);

  return res.status(403).json({
    success: false,
    error: 'Forbidden',
    message: 'Access denied. Admin privileges are required.',
  });
}

/**
 * Checks if a user has admin privileges.
 * Checks ADMIN_EMAILS env var and the local JSON DB.
 */
function checkAdminRole(user) {
  if (!user) return false;

  const { email } = extractUserInfo(user);
  if (!email) return false;

  const superAdminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e);

  if (superAdminEmails.includes(email.toLowerCase())) return true;

  // Check local JSON db as a fallback
  try {
    const db = require('../utils/db');
    return db.getUserRole(email) === 'admin';
  } catch (e) {
    return false;
  }
}

module.exports = {
  ensureAuthenticated,
  ensureAdmin,
  checkAdminRole,
  extractUserInfo,
};
