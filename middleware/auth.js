const admin = require('firebase-admin');
const { checkIsAdmin, isSuperAdmin } = require('../services/adminDb');
const logger = require('../utils/logger');

async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || decoded.email || 'User',
      picture: decoded.picture || null,
      emailVerified: decoded.email_verified || false
    };
  } catch (err) {
    logger.warn('[AUTH] Firebase token verification failed:', err.message);
  }
  next();
}

function ensureAuthenticated(req, res, next) {
  if (req.firebaseUser) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized',
    message: 'You must be logged in to access this resource.',
  });
}

function extractUserInfo(req) {
  if (req.firebaseUser) {
    return {
      userId: req.firebaseUser.uid || null,
      email: req.firebaseUser.email || null,
      username: req.firebaseUser.name || 'Anonymous'
    };
  }
  
  if (req.user) {
    const email = (
      req.user.email ||
      (req.user.emails && req.user.emails[0]?.value) ||
      null
    );

    let userId = req.user.sub || null;

    if (req.user.identityToken) {
      try {
        const payload = JSON.parse(
          Buffer.from(req.user.identityToken.split('.')[1], 'base64').toString()
        );
        userId = payload.sub || userId;
      } catch (e) {
      }
    }

    if (!userId) {
      userId = req.user.id || req.user.user_id || null;
    }

    const username =
      req.user.name ||
      req.user.given_name ||
      (email ? email.split('@')[0] : 'Anonymous');

    return { userId, email: email ? email.toLowerCase() : null, username };
  }
  
  return { userId: null, email: null, username: 'Anonymous' };
}

async function ensureAdmin(req, res, next) {
  if (!req.firebaseUser) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'You must be logged in to access this resource.',
    });
  }

  try {
    const { email } = extractUserInfo(req);
    const adminStatus = await checkIsAdmin(email);

    if (adminStatus) return next();

    const { username } = extractUserInfo(req);
    logger.warn(`[AUTH] Admin access denied for user: ${username}`);

    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Access denied. Admin privileges are required.',
    });
  } catch (err) {
    logger.error('[AUTH] ensureAdmin error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Server Error',
      message: 'Failed to verify admin status.',
    });
  }
}

async function checkAdminRole(req) {
  const { email } = extractUserInfo(req);
  if (!email) return false;
  return checkIsAdmin(email);
}

function checkAdminRoleSync(req) {
  const { email } = extractUserInfo(req);
  if (!email) return false;
  return isSuperAdmin(email);
}

module.exports = {
  verifyFirebaseToken,
  ensureAuthenticated,
  ensureAdmin,
  checkAdminRole,
  checkAdminRoleSync,
  extractUserInfo,
};
