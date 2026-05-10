// ============================================
// CloudIQ Backend - Authentication Middleware
// ============================================
// Protects routes by verifying user authentication status.
// Admin checks are backed by Cloudant 'admins' database.

const { checkIsAdmin, isSuperAdmin } = require('../services/adminDb');

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

  const email = (
    reqUser.email ||
    (reqUser.emails && reqUser.emails[0]?.value) ||
    null
  );

  let userId = reqUser.sub || null;

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

  // Backward-compatible fallback for non-App ID local/dev sessions only.
  // Permission-bearing records should still be written with IBM App ID sub.
  if (!userId) {
    userId = reqUser.id || reqUser.user_id || null;
  }

  const username =
    reqUser.name ||
    reqUser.given_name ||
    (email ? email.split('@')[0] : 'Anonymous');

  return { userId, email: email ? email.toLowerCase() : null, username };
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

  return res.redirect('/api/auth/login');
}

/**
 * Middleware: Ensures the user has admin role (async).
 * Must be used AFTER ensureAuthenticated.
 * Uses Cloudant 'admins' DB + ADMIN_EMAILS env var.
 */
async function ensureAdmin(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'You must be logged in to access this resource.',
    });
  }

  try {
    const { email } = extractUserInfo(req.user);
    const adminStatus = await checkIsAdmin(email);

    if (adminStatus) return next();

    const { username } = extractUserInfo(req.user);
    console.warn(`[AUTH] Admin access denied for user: ${username}`);

    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Access denied. Admin privileges are required.',
    });
  } catch (err) {
    console.error('[AUTH] ensureAdmin error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Server Error',
      message: 'Failed to verify admin status.',
    });
  }
}

/**
 * Async check: Is the user an admin?
 * Checks ADMIN_EMAILS env var (super admin) + Cloudant 'admins' DB.
 * @param {Object} user - Passport user object (req.user)
 * @returns {Promise<boolean>}
 */
async function checkAdminRole(user) {
  if (!user) return false;
  const { email } = extractUserInfo(user);
  if (!email) return false;
  return checkIsAdmin(email);
}

/**
 * Synchronous super-admin check only (for use where async is not possible).
 * Falls back to env var only — does NOT check Cloudant.
 * Prefer checkAdminRole() for full admin verification.
 * @param {Object} user - Passport user object (req.user)
 * @returns {boolean}
 */
function checkAdminRoleSync(user) {
  if (!user) return false;
  const { email } = extractUserInfo(user);
  if (!email) return false;
  return isSuperAdmin(email);
}

module.exports = {
  ensureAuthenticated,
  ensureAdmin,
  checkAdminRole,
  checkAdminRoleSync,
  extractUserInfo,
};
