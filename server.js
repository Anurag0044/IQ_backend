// ============================================
// CloudIQ Backend - Main Server
// ============================================
// Complete auth flow:
//   Login:  Frontend → /auth/login → IBM App ID → /auth/callback
//           → Checks admin status in Cloudant
//           → Admin: redirect to /admin  |  User: redirect to /dashboard
//   Logout: Frontend → /auth/logout → destroy session → Frontend /
//   Check:  Frontend → /auth/user → { loggedIn: true/false, user }
//   Role:   Frontend → /api/user-role → { email, isAdmin }

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { WebAppStrategy } = require('ibmcloud-appid');

const adminRoutes = require('./routes/admin');
const adminDb = require('./services/adminDb');
const userRoutes = require('./routes/user');
const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const communityRoutes = require('./routes/community');
const notificationsRoutes = require('./routes/notifications');
const voiceRoutes = require('./routes/voice');
const commentsRoutes = require('./routes/comments');
const friendsRoutes = require('./routes/friends');
const tutorialsRoutes = require('./routes/tutorials');
const orionRoutes = require('./routes/orion');

const app = express();
const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const hasAppIdCredentials = Boolean(
  process.env.APPID_TENANT_ID &&
  process.env.APPID_CLIENT_ID &&
  process.env.APPID_SECRET &&
  process.env.APPID_OAUTH_SERVER_URL &&
  process.env.APPID_REDIRECT_URI
);

// ─────────────────────────────────────────────
// Setup Socket.IO
// ─────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    credentials: true,
  }
});

const userSockets = new Map();
app.set('io', io);
app.set('userSockets', userSockets);

io.on('connection', (socket) => {
  console.log(`[SOCKET] Client connected: ${socket.id}`);

  socket.on('register', (userId) => {
    userSockets.set(userId, socket.id);
    console.log(`[SOCKET] User mapped: ${userId} -> ${socket.id}`);
  });

  socket.on('watch_post', (postId) => {
    if (postId) socket.join(`post:${postId}`);
  });

  socket.on('unwatch_post', (postId) => {
    if (postId) socket.leave(`post:${postId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[SOCKET] Client disconnected: ${socket.id}`);
    for (let [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });
});

// ─────────────────────────────────────────────
// 1. Security
// ─────────────────────────────────────────────
// Trust proxy is required for Render/Heroku to properly handle HTTPS and secure cookies
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));

// ─────────────────────────────────────────────
// 2. CORS — frontend origin + cookies
// ─────────────────────────────────────────────
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─────────────────────────────────────────────
// 3. Parsing & Logging
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ─────────────────────────────────────────────
// 4. Session — MUST be before Passport
// ─────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';

app.use(session({
  secret: process.env.SESSION_SECRET || 'cloudiq-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,         // true for Render (HTTPS)
    httpOnly: true,               // JS cannot access cookie
    maxAge: 24 * 60 * 60 * 1000,  // 24 hours
    sameSite: isProduction ? 'none' : 'lax', // 'none' required for cross-domain cookies on Render
  },
}));

// ─────────────────────────────────────────────
// 5. Passport — MUST be after Session
// ─────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// IBM App ID strategy
if (hasAppIdCredentials) {
  passport.use(new WebAppStrategy({
    tenantId: process.env.APPID_TENANT_ID,
    clientId: process.env.APPID_CLIENT_ID,
    secret: process.env.APPID_SECRET,
    oauthServerUrl: process.env.APPID_OAUTH_SERVER_URL,
    redirectUri: process.env.APPID_REDIRECT_URI,
  }));
} else {
  console.warn('[AUTH] IBM App ID credentials are missing. Authentication routes will return a 503 until configured.');
}

// Store entire user object in session
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ═════════════════════════════════════════════
//              AUTH ROUTES
// ═════════════════════════════════════════════

/**
 * GET /auth/login
 * Step 1: Frontend sends user here
 * Step 2: Redirect to IBM App ID for authentication
 */
app.get('/auth/login', (req, res, next) => {
  if (!hasAppIdCredentials) {
    return res.status(503).send('Authentication is not configured on this backend instance.');
  }

  return passport.authenticate(WebAppStrategy.STRATEGY_NAME)(req, res, next);
});

/**
 * GET /auth/callback
 * Step 3: IBM App ID redirects here after user logs in
 * Step 4: Passport processes the auth code, creates session
 * Step 5: MUST redirect to frontend dashboard
 *
 * ⚠️ THIS IS THE MOST CRITICAL ROUTE
 * Without the res.redirect(), user gets stuck on App ID page
 */
app.get('/auth/callback', (req, res, next) => {
  if (!hasAppIdCredentials) {
    return res.status(503).send('Authentication is not configured on this backend instance.');
  }

  passport.authenticate(WebAppStrategy.STRATEGY_NAME, (err, user, info) => {
    // Handle authentication errors
    if (err) {
      console.error('[AUTH] ❌ Callback error:', err.message || err);
      return res.redirect(FRONTEND_URL + '/?error=auth_error');
    }

    // Handle authentication failure (no user returned)
    if (!user) {
      console.error('[AUTH] ❌ Authentication failed. Info:', info);
      return res.redirect(FRONTEND_URL + '/?error=auth_failed');
    }

    // Log the user into the session
    req.logIn(user, async (loginErr) => {
      if (loginErr) {
        console.error('[AUTH] ❌ Session login error:', loginErr.message || loginErr);
        return res.redirect(FRONTEND_URL + '/?error=session_error');
      }

      // ✅ SUCCESS — check admin role BEFORE redirecting
      const email = (user.email || (user.emails && user.emails[0]?.value) || '').toLowerCase();
      console.log('[AUTH] ✅ Login successful:', user.name || email || 'Unknown');

      try {
        const isAdmin = await adminDb.checkIsAdmin(email);
        const redirectPath = isAdmin ? '/admin' : '/dashboard';
        console.log(`[AUTH] ✅ User is ${isAdmin ? 'ADMIN' : 'USER'} → Redirecting to: ${FRONTEND_URL}${redirectPath}`);
        return res.redirect(FRONTEND_URL + redirectPath);
      } catch (adminErr) {
        console.error('[AUTH] ⚠️ Admin check failed, defaulting to /dashboard:', adminErr.message);
        return res.redirect(FRONTEND_URL + '/dashboard');
      }
    });
  })(req, res, next);
});

/**
 * GET /auth/logout
 * Step 1: Frontend sends user here
 * Step 2: Destroy session, clear cookies
 * Step 3: Redirect to frontend landing page
 *
 * The frontend does NOT clear its state manually.
 * When landing page loads, AuthContext calls /auth/user → gets loggedIn:false → UI updates.
 */
app.get('/auth/logout', (req, res, next) => {
  console.log('[AUTH] Logout requested');

  // Clear IBM App ID tokens from session
  if (hasAppIdCredentials) {
    try { WebAppStrategy.logout(req); } catch (e) { /* ignore */ }
  }

  // Passport v0.6+ requires callback
  req.logout(function (err) {
    if (err) {
      console.error('[AUTH] ❌ Passport logout error:', err);
      return next(err);
    }

    // Destroy the entire session
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        console.error('[AUTH] ❌ Session destroy error:', destroyErr);
      }

      // Clear the session cookie from browser
      res.clearCookie('connect.sid');

      // ✅ Redirect to frontend landing page
      console.log('[AUTH] ✅ Logged out. Redirecting to:', FRONTEND_URL);
      return res.redirect(FRONTEND_URL);
    });
  });
});

/**
 * GET /auth/user
 * Called by frontend on EVERY page load to check session
 * Returns { loggedIn: true/false, user: {...} }
 *
 * This is what keeps frontend and backend IN SYNC.
 * NEVER returns 401 — always returns JSON so frontend can handle it.
 */
app.get('/auth/user', async (req, res) => {
  // Check if user has an active session
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({
      loggedIn: false,
      success: false,
      user: null,
    });
  }

  const user = req.user;
  const roles = extractRoles(user);
  const email = (user.email || user.emails?.[0]?.value || '').toLowerCase();

  // Sync user to database (creates them if they don't exist, updates lastLogin)
  try {
    const db = require('./utils/db');
    db.syncUser(user);
  } catch (e) { /* non-fatal */ }

  // Async admin check against Cloudant
  let isAdmin = false;
  try {
    isAdmin = await adminDb.checkIsAdmin(email);
  } catch (e) {
    console.error('[AUTH] /auth/user admin check error:', e.message);
  }

  return res.json({
    loggedIn: true,
    success: true,
    user: {
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
 * Quick auth check (lightweight, no user data)
 */
app.get('/auth/status', async (req, res) => {
  const authenticated = req.isAuthenticated ? req.isAuthenticated() : false;
  let isAdmin = false;
  if (authenticated && req.user) {
    try {
      const email = (req.user.email || req.user.emails?.[0]?.value || '').toLowerCase();
      isAdmin = await adminDb.checkIsAdmin(email);
    } catch (e) { /* ignore */ }
  }
  res.json({ authenticated, isAdmin });
});

/**
 * GET /debug-user
 * Debug only — shows raw user object and role locations
 */
app.get('/debug-user', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({
      loggedIn: false,
      message: 'Not logged in. Go to http://localhost:' + PORT + '/auth/login first.',
    });
  }
  const user = req.user;
  const roles = extractRoles(user);
  const email = (user.email || user.emails?.[0]?.value || '').toLowerCase();

  // Sync user here too just in case
  try { const db = require('./utils/db'); db.syncUser(user); } catch (e) { }

  let isAdmin = false;
  try { isAdmin = await adminDb.checkIsAdmin(email); } catch (e) { }

  res.json({
    loggedIn: true,
    email,
    extractedRoles: roles,
    isAdmin,
    rawUser: user,
  });
});

// ─────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ service: 'CloudIQ Backend', status: 'running', timestamp: new Date().toISOString() });
});

// ═════════════════════════════════════════════
//              ROLE + ADMIN MANAGEMENT APIs
// ═════════════════════════════════════════════

/**
 * GET /api/user-role
 * Verifies session and returns the user's email + isAdmin status.
 * Frontend calls this AFTER login to decide which dashboard to show.
 */
app.get('/api/user-role', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
  }

  const user = req.user;
  const email = (user.email || user.emails?.[0]?.value || '').toLowerCase();

  if (!email) {
    return res.status(400).json({ success: false, error: 'No email found in session.' });
  }

  try {
    const isAdmin = await adminDb.checkIsAdmin(email);
    const adminRole = isAdmin ? (await adminDb.getAdminRole(email)) : null;
    return res.json({ success: true, email, isAdmin, adminRole });
  } catch (err) {
    console.error('[API] /api/user-role error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to check role.' });
  }
});

/**
 * POST /api/add-admin
 * Adds a new admin email to the Cloudant 'admins' database.
 * ONLY the super admin (ADMIN_EMAILS env var) can call this.
 *
 * Body: { "newAdminEmail": "admin@example.com" }
 */
app.post('/api/add-admin', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
  }

  const callerEmail = (
    req.user.email || req.user.emails?.[0]?.value || ''
  ).toLowerCase();

  // Only the super admin can add other admins
  if (!adminDb.isSuperAdmin(callerEmail)) {
    console.warn(`[API] /api/add-admin: Non-super-admin attempt by ${callerEmail}`);
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Only the super admin can add other admins.',
    });
  }

  const { newAdminEmail } = req.body;
  if (!newAdminEmail || typeof newAdminEmail !== 'string') {
    return res.status(400).json({ success: false, error: 'newAdminEmail is required.' });
  }

  const result = await adminDb.addAdmin(newAdminEmail);
  return res.status(result.success ? 200 : 400).json(result);
});

/**
 * DELETE /api/remove-admin
 * Removes an admin email from the Cloudant 'admins' database.
 * ONLY the super admin can call this.
 *
 * Body: { "adminEmail": "admin@example.com" }
 */
app.delete('/api/remove-admin', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
  }

  const callerEmail = (
    req.user.email || req.user.emails?.[0]?.value || ''
  ).toLowerCase();

  if (!adminDb.isSuperAdmin(callerEmail)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Only the super admin can remove admins.',
    });
  }

  const { adminEmail } = req.body;
  if (!adminEmail) {
    return res.status(400).json({ success: false, error: 'adminEmail is required.' });
  }

  const result = await adminDb.removeAdmin(adminEmail);
  return res.status(result.success ? 200 : 400).json(result);
});

/**
 * GET /api/list-admins
 * Returns a list of all admins (super admin + Cloudant admins).
 * ONLY accessible by the super admin.
 */
app.get('/api/list-admins', async (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
  }

  const callerEmail = (
    req.user.email || req.user.emails?.[0]?.value || ''
  ).toLowerCase();

  if (!adminDb.isSuperAdmin(callerEmail)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Only the super admin can list admins.',
    });
  }

  try {
    const admins = await adminDb.listAdmins();
    return res.json({ success: true, admins });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════
//              API ROUTES
// ═════════════════════════════════════════════
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/communities', communityRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/tutorials', tutorialsRoutes);
app.use('/api/orion', orionRoutes);

// ─────────────────────────────────────────────
// 404 + Error Handlers
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not Found', message: `${req.method} ${req.originalUrl} does not exist.` });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message || err);
  res.status(err.statusCode || 500).json({ success: false, error: 'Server Error', message: err.message || 'Something went wrong' });
});

// ─────────────────────────────────────────────
// Role Extraction Helper
// ─────────────────────────────────────────────
function extractRoles(user) {
  if (!user) return [];
  const rolesSet = new Set();

  // _json.roles — where App ID puts roles when "Add roles to ID token" is enabled
  if (user._json && Array.isArray(user._json.roles)) {
    user._json.roles.forEach((r) => rolesSet.add(r));
  }
  // Direct roles array
  if (Array.isArray(user.roles)) {
    user.roles.forEach((r) => rolesSet.add(r));
  }
  // Identity token decode
  if (user.identityToken) {
    try {
      const p = JSON.parse(Buffer.from(user.identityToken.split('.')[1], 'base64').toString());
      if (Array.isArray(p.roles)) p.roles.forEach((r) => rolesSet.add(r));
    } catch (e) { /* skip */ }
  }
  // Attributes
  if (user.attributes?.role) rolesSet.add(user.attributes.role);

  return Array.from(rolesSet);
}

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     CloudIQ Backend API Server           ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Port:     ${PORT}                          ║`);
  console.log(`║  Frontend: ${FRONTEND_URL.padEnd(27)}║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Auth Flow:                              ║');
  console.log('║  /auth/login → IBM App ID login          ║');
  console.log('║  /auth/callback → session + redirect     ║');
  console.log('║  /auth/logout → destroy + redirect       ║');
  console.log('║  /auth/user → session check (JSON)       ║');
  console.log('║  /debug-user → raw user object           ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  if (hasAppIdCredentials) {
    console.log('  Register this callback URL in IBM App ID:');
    console.log(`  → ${process.env.APPID_REDIRECT_URI}`);
    console.log('');
  } else {
    console.log('  IBM App ID is disabled until the required environment variables are provided.');
    console.log('');
  }
});

module.exports = app;
