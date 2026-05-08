// ============================================
// CloudIQ Backend - Authentication Routes
// ============================================
// Handles login, callback, logout, and session info
// FIXED: Passport.js v0.6+ requires callback on req.logout()
// FIXED: /auth/user returns loggedIn:false instead of 401
// FIXED: Role extraction from _json.roles (App ID actual location)

const express = require('express');
const passport = require('passport');
const { WebAppStrategy } = require('ibmcloud-appid');
const { checkAdminRole, extractUserInfo } = require('../middleware/auth');
const adminDb = require('../services/adminDb');

const router = express.Router();
const { ensureAuthenticated } = require('../middleware/authMiddleware');


/**
 * GET /auth/login
 * Initiates IBM App ID login flow
 * Redirects user to App ID hosted login page
 */
router.get('/login', passport.authenticate(WebAppStrategy.STRATEGY_NAME, {
  forceLogin: true,
}));

/**
 * GET /auth/callback
 * IBM App ID redirects here after successful authentication
 * Processes the auth code and creates a session
 */
router.get('/callback', passport.authenticate(WebAppStrategy.STRATEGY_NAME, {
  failureRedirect: `${process.env.FRONTEND_URL}/?error=auth_failed`,
  failureFlash: false,
}), async (req, res) => {
  // Authentication successful — check role and redirect appropriately
  const email = (
    req.user?.email || req.user?.emails?.[0]?.value || ''
  ).toLowerCase();
  console.log(`[AUTH] User authenticated: ${req.user?.name || email || 'Unknown'}`);

  try {
    const isAdmin = await adminDb.checkIsAdmin(email);
    const redirectPath = isAdmin ? '/admin' : '/dashboard';
    console.log(`[AUTH] Redirecting ${email} to ${process.env.FRONTEND_URL}${redirectPath}`);
    res.redirect(`${process.env.FRONTEND_URL}${redirectPath}`);
  } catch (err) {
    console.error('[AUTH] Admin check error, defaulting to /dashboard:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard`);
  }
});

/**
 * GET /auth/logout
 * Destroys user session and clears cookies
 * FIXED: req.logout() requires callback in Passport.js >= 0.6
 */
router.get('/logout', (req, res, next) => {
  // Clear the App ID tokens from session
  try {
    WebAppStrategy.logout(req);
  } catch (e) {
    console.error('[AUTH] WebAppStrategy.logout error:', e.message);
  }

  // Passport logout with required callback
  req.logout(function (err) {
    if (err) {
      console.error('[AUTH] Passport logout error:', err);
      return next(err);
    }

    // Destroy the express session
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        console.error('[AUTH] Session destruction error:', destroyErr);
      }

      // Clear all possible session cookies
      res.clearCookie('cloudiq.sid');
      res.clearCookie('connect.sid');

      // Redirect to frontend landing page
      res.redirect(process.env.FRONTEND_URL || '/');
    });
  });
});

/**
 * GET /auth/user
 * Returns the current authenticated user's info
 * FIXED: Returns loggedIn:false instead of 401 when not authenticated
 * This allows the frontend to check auth state without triggering redirects
 */
router.get('/user', async (req, res) => {
  // If not authenticated, return loggedIn: false (NOT a 401)
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({
      loggedIn: false,
      success: false,
      user: null,
    });
  }

  const user = req.user;
  const { userId } = extractUserInfo(user);
  const roles = extractRoles(user);
  const email = (user.email || user.emails?.[0]?.value || '').toLowerCase();

  // Async admin check against Cloudant + ADMIN_EMAILS
  let isAdmin = false;
  try {
    isAdmin = await adminDb.checkIsAdmin(email);
  } catch (e) {
    console.error('[AUTH] /auth/user admin check failed:', e.message);
  }

  // Build a safe user response (no tokens exposed to frontend)
  res.json({
    loggedIn: true,
    success: true,
    user: {
      sub: userId || null,
      userId: userId || null,
      name: user.name || user.given_name || 'User',
      email: email || null,
      picture: user.picture || null,
      isAdmin: isAdmin,
      roles: roles,
    },
  });
});

/**
 * GET /auth/status
 * Quick check if user is authenticated (no sensitive data)
 */
router.get('/status', async (req, res) => {
  const authenticated = req.isAuthenticated ? req.isAuthenticated() : false;
  let isAdmin = false;

  if (authenticated && req.user) {
    try {
      const email = (req.user.email || req.user.emails?.[0]?.value || '').toLowerCase();
      isAdmin = await adminDb.checkIsAdmin(email);
    } catch (e) { /* ignore */ }
  }

  res.json({
    authenticated,
    isAdmin,
  });
});

/**
 * GET /debug-user
 * DEBUG ONLY — dumps the raw user object from session
 * Use this to verify what App ID returns and where roles live
 * Visit: http://localhost:5000/auth/debug-user
 */
router.get('/debug-user', (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({
      loggedIn: false,
      message: 'Not authenticated. Login first at /auth/login',
    });
  }

  // Return the full raw user object for debugging
  const user = req.user;
  const roles = extractRoles(user);

  res.json({
    loggedIn: true,
    extractedRoles: roles,
    isAdmin: roles.includes(process.env.ADMIN_ROLE_NAME || 'admin'),
    rawUser: user,
    // Show exactly where we found roles
    roleLocations: {
      'user.roles': user.roles || 'NOT FOUND',
      'user._json.roles': user._json?.roles || 'NOT FOUND',
      'identityToken.roles': (() => {
        try {
          if (!user.identityToken) return 'NO TOKEN';
          const p = JSON.parse(Buffer.from(user.identityToken.split('.')[1], 'base64').toString());
          return p.roles || 'NOT IN TOKEN';
        } catch { return 'DECODE ERROR'; }
      })(),
      'accessToken.scope': (() => {
        try {
          if (!user.accessToken) return 'NO TOKEN';
          const p = JSON.parse(Buffer.from(user.accessToken.split('.')[1], 'base64').toString());
          return p.scope || 'NOT IN TOKEN';
        } catch { return 'DECODE ERROR'; }
      })(),
      'user.attributes.role': user.attributes?.role || 'NOT FOUND',
    },
  });
});

/**
 * Extract roles from the user object
 * Checks ALL known locations where IBM App ID stores roles
 * @param {Object} user - Passport user object
 * @returns {string[]} Array of role names
 */
function extractRoles(user) {
  if (!user) return [];

  const rolesSet = new Set();

  // 1. Direct roles array on user object
  if (Array.isArray(user.roles)) {
    user.roles.forEach((r) => rolesSet.add(r));
  }

  // 2. _json.roles — THIS IS WHERE APP ID ACTUALLY PUTS ROLES
  //    When "Add roles to ID token" is enabled in App ID dashboard
  if (user._json && Array.isArray(user._json.roles)) {
    user._json.roles.forEach((r) => rolesSet.add(r));
  }

  // 3. Identity token roles claim
  if (user.identityToken) {
    try {
      const payload = JSON.parse(
        Buffer.from(user.identityToken.split('.')[1], 'base64').toString()
      );
      if (Array.isArray(payload.roles)) {
        payload.roles.forEach((r) => rolesSet.add(r));
      }
    } catch (e) {
      // silently skip
    }
  }

  // 4. Access token scope
  if (user.accessToken) {
    try {
      const payload = JSON.parse(
        Buffer.from(user.accessToken.split('.')[1], 'base64').toString()
      );
      if (typeof payload.scope === 'string') {
        // scope is space-separated
        payload.scope.split(' ').forEach((s) => {
          if (s && !s.startsWith('openid')) rolesSet.add(s);
        });
      }
    } catch (e) {
      // silently skip
    }
  }

  // 5. User attributes
  if (user.attributes?.role) {
    rolesSet.add(user.attributes.role);
  }

  return Array.from(rolesSet);
}

module.exports = router;
