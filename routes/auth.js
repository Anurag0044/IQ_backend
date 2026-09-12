const express = require('express');
const { verifyFirebaseToken } = require('../middleware/auth');
const adminDb = require('../services/adminDb');
const db = require('../services/firestoreClient');
const logger = require('../utils/logger');

const router = express.Router();

router.use(verifyFirebaseToken);

/**
 * GET /user
 * Returns the current authenticated user's info
 */
router.get('/user', async (req, res) => {
  if (!req.firebaseUser) {
    return res.json({
      loggedIn: false,
      success: false,
      user: null,
    });
  }

  const { uid, email, name, picture } = req.firebaseUser;

  // Async admin check
  let isAdmin = false;
  try {
    isAdmin = await adminDb.checkIsAdmin(email);
  } catch (e) {
    logger.error('[AUTH] /auth/user admin check failed:', e.message);
  }

  res.json({
    loggedIn: true,
    success: true,
    user: {
      sub: uid,
      userId: uid,
      name: name,
      email: email,
      picture: picture,
      isAdmin: isAdmin,
    },
  });
});

/**
 * GET /status
 * Quick check if user is authenticated
 */
router.get('/status', async (req, res) => {
  const authenticated = !!req.firebaseUser;
  let isAdmin = false;

  if (authenticated) {
    try {
      isAdmin = await adminDb.checkIsAdmin(req.firebaseUser.email);
    } catch (e) { /* ignore */ }
  }

  res.json({
    authenticated,
    isAdmin,
  });
});

/**
 * POST /sync
 * Synchronize user profile in Firestore
 */
router.post('/sync', async (req, res) => {
  if (!req.firebaseUser) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { uid, email } = req.firebaseUser;
  const { displayName, photoURL } = req.body;

  try {
    const updateData = {
      email,
      last_login: new Date().toISOString()
    };
    
    if (displayName) updateData.name = displayName;
    if (photoURL) updateData.avatar = photoURL;

    await db.batchSet('users', uid, updateData);

    res.json({ success: true, message: 'User synced successfully' });
  } catch (err) {
    logger.error('[AUTH] Failed to sync user:', err.message);
    res.status(500).json({ success: false, error: 'Failed to sync user' });
  }
});

module.exports = router;
