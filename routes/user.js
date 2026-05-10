// ============================================
// CloudIQ Backend - User Profile Routes
// ============================================
// GET  /api/user/profile     â€” check onboarding + return profile
// POST /api/user/onboarding  â€” first-time setup (username, purpose, image)
// PUT  /api/user/profile     â€” update username / profile image

const express = require('express');
const multer = require('multer');
const cloudant = require('../services/cloudantClient');
const { uploadBuffer, deleteImage } = require('../services/cloudinaryService');
const { ensureAuthenticated } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();
const DB_NAME = 'users'; // existing Cloudant DB

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Multer â€” profile images (5 MB, jpeg/png/webp)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, or WEBP images are allowed.'), false);
  },
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getUserId(req) {
  // App ID stores the subject as `sub` or `id`
  return (
    req.user?.sub ||
    req.user?.id ||
    req.user?.uid ||
    req.user?.email ||
    (req.user?.emails && req.user.emails[0]?.value) ||
    'unknown'
  );
}

function getUserEmail(req) {
  return (
    req.user?.email ||
    (req.user?.emails && req.user.emails[0]?.value) ||
    ''
  ).toLowerCase();
}

function extractPublicId(url) {
  if (!url) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]{2,5}$/i);
  return match ? match[1] : null;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/user/profile
// Check if user is onboarded; return profile if yes
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/profile', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);

    try {
      const doc = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;
      const { profile_image_public_id, _rev, ...safe } = doc;
      return res.json({ success: true, is_onboarded: true, data: safe });
    } catch (err) {
      if (err.status === 404) {
        // New user â€” not yet onboarded
        return res.json({
          success: true,
          is_onboarded: false,
          data: { email: getUserEmail(req) },
        });
      }
      throw err;
    }
  } catch (err) {
    logger.error('[User] Get profile error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/user/dashboard
// Returns real-time timeSpent, tutorialsCount, activities
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/dashboard', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);

    // 1. Fetch user doc for time_spent + activities
    let userDoc;
    try {
      userDoc = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;
    } catch (err) {
      if (err.status === 404) {
        return res.json({ success: true, data: { timeSpent: 0, tutorialsCount: 0, activities: [] } });
      }
      throw err;
    }

    // 2. Count tutorials
    let tutorialsCount = 0;
    try {
      const tutResp = await cloudant.postAllDocs({ db: 'tutorials' });
      tutorialsCount = (tutResp.result.rows || []).filter(r => !r.id.startsWith('_design')).length;
    } catch (err) {
      logger.warn('[User] tutorials count failed:', err.message);
    }

    return res.json({
      success: true,
      data: {
        timeSpent: userDoc.time_spent || 0,
        points: userDoc.points || 0,
        dailyTimeSpent: userDoc.daily_time_spent || {},
        tutorialsCount,
        activities: userDoc.activities || [],
      },
    });
  } catch (err) {
    logger.error('[User] Dashboard error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PUT /api/user/sync-session
// Adds elapsed minutes to time_spent, optionally logs an activity
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/sync-session', ensureAuthenticated, async (req, res) => {
  const MAX_RETRIES = 2;
  try {
    const userId = getUserId(req);
    const { timeAdded = 0, activity, pointsAdded = 0 } = req.body;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const existing = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;

        let time_spent = (existing.time_spent || 0) + timeAdded;
        let points = (existing.points || 0) + pointsAdded;

        let daily_time_spent = existing.daily_time_spent || {};
        if (timeAdded > 0) {
          const today = new Date().toISOString().split('T')[0];
          daily_time_spent[today] = (daily_time_spent[today] || 0) + timeAdded;
        }

        let activities = existing.activities || [];
        if (activity) {
          activities.unshift({
            title: activity.title || 'Activity',
            desc: activity.desc || '',
            icon: activity.icon || 'BookOpen',
            time: new Date().toISOString(),
          });
          if (activities.length > 10) activities = activities.slice(0, 10);
        }

        const updated = { ...existing, time_spent, points, daily_time_spent, activities, updated_at: new Date().toISOString() };
        // Use postDocument (not putDocument) â€” Cloudant IAM key may lack PUT permission
        // postDocument with _id + _rev in the body performs an update
        await cloudant.postDocument({ db: DB_NAME, document: updated });

        return res.json({ success: true, data: { timeSpent: time_spent, points, dailyTimeSpent: daily_time_spent, activities } });
      } catch (innerErr) {
        // 409 = rev conflict, retry with fresh doc
        if (innerErr.status === 409 && attempt < MAX_RETRIES) {
          logger.warn(`[User] sync-session rev conflict, retrying (${attempt + 1}/${MAX_RETRIES})`);
          continue;
        }
        throw innerErr;
      }
    }
  } catch (err) {
    logger.error('[User] sync-session error:', err.status, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/user/courses (legacy stub)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/courses', ensureAuthenticated, (req, res) => {
  res.json({ success: true, data: { enrolled: [], recommended: [], completed: [] } });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/user/onboarding
// First-time user setup â€” creates Cloudant document
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/onboarding', ensureAuthenticated, upload.single('profile_image'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const email = getUserEmail(req);
    const { username, purpose, referral_source, professional_role } = req.body;

    if (!username?.trim()) {
      return res.status(400).json({ success: false, error: 'Username is required.' });
    }

    // Upload profile image to Cloudinary
    let profile_image_url = null;
    let profile_image_public_id = null;

    if (req.file) {
      const result = await uploadBuffer(req.file.buffer, 'profile_images');
      profile_image_url = result.secure_url;
      profile_image_public_id = result.public_id;
    }

    const userDoc = {
      _id: userId,
      email,
      username: username.trim(),
      professional_role: professional_role?.trim() || '',
      purpose: purpose?.trim() || '',
      referral_source: referral_source || '',
      profile_image_url,
      profile_image_public_id,
      is_onboarded: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const response = await cloudant.postDocument({ db: DB_NAME, document: userDoc });

    if (!response.result.ok) throw new Error('Cloudant did not confirm document creation');

    logger.info(`[User] Onboarding complete: ${username} (${email})`);

    const { profile_image_public_id: _p, ...safe } = userDoc;
    return res.status(201).json({ success: true, data: safe });
  } catch (err) {
    logger.error('[User] Onboarding error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PUT /api/user/profile
// Update username and/or profile image
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/profile', ensureAuthenticated, upload.single('profile_image'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const { username, professional_role } = req.body;

    // Fetch existing document (_rev required for Cloudant update)
    const existing = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;

    let profile_image_url = existing.profile_image_url;
    let profile_image_public_id = existing.profile_image_public_id;

    if (req.file) {
      // Delete old Cloudinary image (non-blocking)
      const oldId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
      if (oldId) {
        try { await deleteImage(oldId); }
        catch (e) { logger.error('[User] Old image delete failed:', e.message); }
      }
      const result = await uploadBuffer(req.file.buffer, 'profile_images');
      profile_image_url = result.secure_url;
      profile_image_public_id = result.public_id;
    }

    const updated = {
      ...existing,
      username: username?.trim() || existing.username,
      professional_role: professional_role !== undefined
        ? professional_role.trim()
        : (existing.professional_role || ''),
      profile_image_url,
      profile_image_public_id,
      updated_at: new Date().toISOString(),
    };

    await cloudant.postDocument({ db: DB_NAME, document: updated });
    logger.info(`[User] Profile updated: ${updated.username} (${userId})`);

    const { profile_image_public_id: _p, _rev: _r, ...safe } = updated;
    return res.json({ success: true, data: safe });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: 'Profile not found. Please complete onboarding first.' });
    }
    logger.error('[User] Update profile error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DELETE /api/user/profile-image
// Remove profile picture â€” clears Cloudinary + nulls DB field
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.delete('/profile-image', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);
    const existing = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;

    const publicId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
    if (publicId) {
      try { await deleteImage(publicId); }
      catch (e) { logger.error('[User] Cloudinary image delete failed:', e.message); }
    }

    const updated = {
      ...existing,
      profile_image_url: null,
      profile_image_public_id: null,
      updated_at: new Date().toISOString(),
    };
    await cloudant.postDocument({ db: DB_NAME, document: updated });

    logger.info(`[User] Profile image removed for: ${userId}`);
    const { profile_image_public_id: _p, _rev: _r, ...safe } = updated;
    return res.json({ success: true, data: safe });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Profile not found.' });
    logger.error('[User] Delete profile image error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DELETE /api/user/account
// Permanently delete: Cloudinary image + Cloudant doc + session
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.delete('/account', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);

    // Fetch existing doc (may not exist if user never onboarded)
    try {
      const existing = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;

      // Delete Cloudinary profile image
      const publicId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
      if (publicId) {
        try { await deleteImage(publicId); }
        catch (e) { logger.error('[User] Cloudinary delete failed during account deletion:', e.message); }
      }

      // Delete Cloudant document
      await cloudant.deleteDocument({ db: DB_NAME, docId: userId, rev: existing._rev });
      logger.info(`[User] Account deleted from Cloudant: ${userId}`);
    } catch (err) {
      if (err.status !== 404) throw err; // 404 = no profile, still destroy session
    }

    // Destroy session
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      return res.json({ success: true, message: 'Account permanently deleted.' });
    });
  } catch (err) {
    logger.error('[User] Delete account error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

