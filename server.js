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
const logger = require('./utils/logger');
const { extractUserInfo } = require('./middleware/auth');
const { adminCache } = require('./services/cacheService');
const githubAuthRoutes = require("./routes/githubAuth");

const labsRoutes = require("./routes/labs");

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
const discussionsRoutes = require('./routes/discussions');
const firebaseService = require('./services/firebaseService');
const { attachDiscussionSocketHandlers } = require('./sockets/discussions');
const { startLabCleanupService, stopLabCleanupService } = require('./services/labCleanupService');

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

function normalizeSocketUserId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

const { startStatsBroadcaster } = require('./services/statsService');
startStatsBroadcaster(io);

io.on('connection', (socket) => {
  logger.debug('[SOCKET] Client connected', { socketId: socket.id });

  socket.on('register', (payload) => {
    const rawUserId = typeof payload === 'string'
      ? payload
      : (payload && typeof payload === 'object' ? (payload.sub || payload.userId) : null);
    const userId = normalizeSocketUserId(rawUserId);
    if (!userId) {
      socket.emit('socket_error', { code: 'invalid_register', message: 'Invalid socket registration payload.' });
      return;
    }

    // Optional identity details (used by discussion sockets for names/admin checks)
    if (payload && typeof payload === 'object') {
      if (payload.email) socket.data.email = String(payload.email).trim().toLowerCase().slice(0, 254);
      if (payload.username) socket.data.username = String(payload.username).trim().slice(0, 120);
      if (payload.picture) socket.data.picture = String(payload.picture).trim().slice(0, 500);
      if (payload.profile_image_url) socket.data.profile_image_url = String(payload.profile_image_url).trim().slice(0, 500);
      if (payload.avatar) socket.data.avatar = String(payload.avatar).trim().slice(0, 500);
    }

    const existingSocketId = userSockets.get(userId);
    if (existingSocketId && existingSocketId !== socket.id) {
      // Duplicate socket prevention: keep the latest connection only
      try {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          existingSocket.emit('duplicate_session', { reason: 'Another tab/session connected.' });
          existingSocket.disconnect(true);
        }
      } catch (e) { /* ignore */ }
    }
    userSockets.set(userId, socket.id);
    socket.data.userId = userId;
    logger.debug('[SOCKET] User registered', { userId, socketId: socket.id });
  });

  socket.on('watch_post', (postId) => {
    if (postId) socket.join(`post:${postId}`);
  });

  socket.on('unwatch_post', (postId) => {
    if (postId) socket.leave(`post:${postId}`);
  });

  socket.on('disconnect', () => {
    logger.debug('[SOCKET] Client disconnected', { socketId: socket.id });
    for (let [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });

  // Phase 4: discussion sockets (channels/messages/presence)
  attachDiscussionSocketHandlers({ io, socket, cloudant: require('./services/cloudantClient') });
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
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '1mb' }));
app.use(morgan(':method :url :status :response-time ms', {
  skip: (_req, res) => res.statusCode < 400 && !logger.shouldLog('debug'),
  stream: {
    write: (message) => {
      const line = message.trim();
      const status = Number(line.match(/\s(\d{3})\s/)?.[1] || 0);
      if (status >= 500) logger.error('[HTTP]', line);
      else if (status >= 400) logger.warn('[HTTP]', line);
      else logger.debug('[HTTP]', line);
    },
  },
}));

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
//____________________________________________________________________________________________________________________________
//github authroutes
app.use("/api/github", githubAuthRoutes);

app.use("/api/labs", labsRoutes);

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
  logger.warn('[AUTH] IBM App ID credentials are missing. Authentication routes will return a 503 until configured.');
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
      logger.error('[AUTH] Callback error:', err.message || err);
      return res.redirect(FRONTEND_URL + '/?error=auth_error');
    }

    // Handle authentication failure (no user returned)
    if (!user) {
      logger.warn('[AUTH] Authentication failed.', info);
      return res.redirect(FRONTEND_URL + '/?error=auth_failed');
    }

    // Log the user into the session
    req.logIn(user, async (loginErr) => {
      if (loginErr) {
        logger.error('[AUTH] Session login error:', loginErr.message || loginErr);
        return res.redirect(FRONTEND_URL + '/?error=session_error');
      }

      // ✅ SUCCESS — check admin role BEFORE redirecting
      const email = (user.email || (user.emails && user.emails[0]?.value) || '').toLowerCase();
      logger.info('[AUTH] Login successful:', user.name || email || 'Unknown');

      try {
        const isAdmin = await adminDb.checkIsAdmin(email);
        const redirectPath = isAdmin ? '/admin' : '/dashboard';
        logger.info(`[AUTH] User is ${isAdmin ? 'ADMIN' : 'USER'}; redirecting to ${FRONTEND_URL}${redirectPath}`);
        return res.redirect(FRONTEND_URL + redirectPath);
      } catch (adminErr) {
        logger.error('[AUTH] Admin check failed, defaulting to /dashboard:', adminErr.message);
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
  logger.info('[AUTH] Logout requested');

  // Clear IBM App ID tokens from session
  if (hasAppIdCredentials) {
    try { WebAppStrategy.logout(req); } catch (e) { /* ignore */ }
  }

  // Passport v0.6+ requires callback
  req.logout(function (err) {
    if (err) {
      logger.error('[AUTH] Passport logout error:', err);
      return next(err);
    }

    // Destroy the entire session
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        logger.error('[AUTH] Session destroy error:', destroyErr);
      }

      // Clear the session cookie from browser
      res.clearCookie('connect.sid');

      // ✅ Redirect to frontend landing page
      logger.info('[AUTH] Logged out. Redirecting to:', FRONTEND_URL);
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
  const { userId } = extractUserInfo(user);

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
    logger.error('[AUTH] /auth/user admin check error:', e.message);
  }

  return res.json({
    loggedIn: true,
    success: true,
    user: {
      userId: userId || null,
      sub: userId || null,
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
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: 'Not Found' });
  }

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

app.get('/api/debug/firestore', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.FIRESTORE_DEBUG_ROUTE_ENABLED !== 'true') {
    return res.status(404).json({ success: false, error: 'Not Found' });
  }

  try {
    logger.debug('[FIRESTORE][DEBUG] route invoked', {
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    });
    const doc = await firebaseService.debugFirestoreWrite();
    return res.json({
      success: true,
      message: 'Firestore debug write succeeded',
      doc,
    });
  } catch (err) {
    logger.error('[FIRESTORE][DEBUG] route failed', err);
    return res.status(500).json({
      success: false,
      error: 'Firestore debug write failed',
      code: 'firestore_debug_failed',
      details: process.env.NODE_ENV !== 'production' ? {
        message: err.message,
        name: err.name,
        code: err.code,
      } : undefined,
    });
  }
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
    logger.error('[API] /api/user-role error:', err.message);
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
  try {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
    }

    const callerEmail = (
      req.user.email || req.user.emails?.[0]?.value || ''
    ).toLowerCase();

    // Only the super admin can add other admins
    if (!adminDb.isSuperAdmin(callerEmail)) {
      logger.warn(`[API] /api/add-admin: Non-super-admin attempt by ${callerEmail}`);
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
    if (result.success) adminCache.delete(`admin:${newAdminEmail.trim().toLowerCase()}`);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    logger.error('[API] /api/add-admin error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to add admin.' });
  }
});

/**
 * DELETE /api/remove-admin
 * Removes an admin email from the Cloudant 'admins' database.
 * ONLY the super admin can call this.
 *
 * Body: { "adminEmail": "admin@example.com" }
 */
app.delete('/api/remove-admin', async (req, res) => {
  try {
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
    if (result.success) adminCache.delete(`admin:${String(adminEmail).trim().toLowerCase()}`);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    logger.error('[API] /api/remove-admin error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to remove admin.' });
  }
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
app.use('/api/discussions', discussionsRoutes);

// ─────────────────────────────────────────────
// 404 + Error Handlers
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not Found', message: `${req.method} ${req.originalUrl} does not exist.` });
});

app.use((err, req, res, next) => {
  logger.error('[ERROR]', err);
  const uploadError = err.name === 'MulterError' || /Only .* allowed|files are allowed|File too large/i.test(err.message || '');
  const status = uploadError ? 400 : (err.status || err.statusCode || 500);
  const isClientError = status >= 400 && status < 500;
  res.status(status).json({
    success: false,
    error: isClientError ? 'Request Error' : 'Server Error',
    message: isClientError || process.env.NODE_ENV !== 'production'
      ? (err.message || 'Something went wrong')
      : 'Something went wrong',
  });
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
  logger.info(`[SERVER] Running on port ${PORT}`);
  logger.info(`[SERVER] Frontend origin ${FRONTEND_URL}`);
  if (hasAppIdCredentials) {
    logger.info('[AUTH] IBM App ID ready');
    logger.debug('[AUTH] App ID callback URL:', process.env.APPID_REDIRECT_URI);
  } else {
    logger.warn('[AUTH] IBM App ID is disabled until the required environment variables are provided.');
  }
  logger.info('[SOCKET] Ready');

  startLabCleanupService();
});

async function shutdown(signal) {
  logger.info(`[SERVER] ${signal} received. Shutting down gracefully...`);
  try {
    await stopLabCleanupService();
  } catch (err) {
    logger.error('[SERVER] Failed to stop lab cleanup service:', err.message);
  }

  server.close(() => {
    logger.info('[SERVER] HTTP server closed.');
    process.exit(0);
  });
}

function isFirestoreGrpcEio(err) {
  const message = String(err?.message || '');
  const stack = String(err?.stack || '');
  return (
    (err?.code === 'EIO' || /EIO: i\/o error, read/i.test(message)) &&
    /@grpc|grpc-js|google-cloud[\\/]firestore|@google-cloud[\\/]firestore/i.test(stack)
  );
}

process.on('unhandledRejection', (reason) => {
  logger.error('[PROCESS] Unhandled promise rejection', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('[PROCESS] Uncaught exception', err);

  if (isFirestoreGrpcEio(err)) {
    logger.error('[FIRESTORE][GRPC] Scoped EIO runtime error captured without terminating process');
    return;
  }

  process.exit(1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
