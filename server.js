// ============================================
// CloudIQ Backend - Main Server
// ============================================
// Auth flow (Firebase):
//   Login:  Client-side Firebase Auth → getIdToken() → Authorization: Bearer <token>
//   Verify: verifyFirebaseToken middleware → admin.auth().verifyIdToken(token)
//   Role:   GET /api/auth/user → { loggedIn, user, isAdmin }
// ============================================

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const logger = require('./utils/logger');
const {
  corsOrigin,
  getBackendUrl,
  getFrontendUrl,
  isProduction,
  joinUrl,
  validateEnvironment,
} = require('./config/env');
const { verifyFirebaseToken, extractUserInfo } = require('./middleware/auth');
const { adminCache } = require('./services/cacheService');
const githubAuthRoutes = require('./routes/githubAuth');
const labsRoutes = require('./routes/labs');
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
const brainstormRoutes = require('./routes/brainstorm');
const firebaseService = require('./services/firebaseService');
const { attachDiscussionSocketHandlers } = require('./sockets/discussions');
const { attachWhiteboardSocketHandlers } = require('./sockets/whiteboard');
const { startLabCleanupService, stopLabCleanupService } = require('./services/labCleanupService');

const app = express();
const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
validateEnvironment();

const FRONTEND_URL = getFrontendUrl();
const BACKEND_URL = getBackendUrl();
const EXPECTED_GITHUB_CALLBACK_URL = joinUrl(BACKEND_URL, '/api/github/callback');
const CONFIGURED_GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || EXPECTED_GITHUB_CALLBACK_URL;

function logMountedRoutes() {
  [
    ['Auth', '/api/auth'],
    ['GitHub OAuth', '/api/github'],
    ['Labs', '/api/labs'],
    ['User', '/api/user'],
    ['Admin', '/api/admin'],
    ['Posts', '/api/posts'],
    ['Communities', '/api/communities'],
    ['Notifications', '/api/notifications'],
    ['Comments', '/api/comments'],
    ['Friends', '/api/friends'],
    ['Voice', '/api/voice'],
    ['Tutorials', '/api/tutorials'],
    ['Orion', '/api/orion'],
    ['Discussions', '/api/discussions'],
    ['Brainstorm', '/api/brainstorm'],
  ].forEach(([name, path]) => logger.info(`[ROUTES] ${name} mounted at ${path}`));

  logger.info('[ROUTES] Health mounted at /');
  logger.info('[ROUTES] Health mounted at /api/health');

  if (CONFIGURED_GITHUB_CALLBACK_URL) {
    logger.info('[ROUTES] GitHub OAuth callback at ' + CONFIGURED_GITHUB_CALLBACK_URL);
  }

  if (EXPECTED_GITHUB_CALLBACK_URL && CONFIGURED_GITHUB_CALLBACK_URL !== EXPECTED_GITHUB_CALLBACK_URL) {
    logger.warn('[ROUTES] GITHUB_CALLBACK_URL differs from BACKEND_URL-derived callback', {
      expected: EXPECTED_GITHUB_CALLBACK_URL,
      configured: CONFIGURED_GITHUB_CALLBACK_URL,
    });
  }

  if (!CONFIGURED_GITHUB_CALLBACK_URL) {
    logger.warn('[ROUTES] GitHub OAuth callback is not configured. Set BACKEND_URL or GITHUB_CALLBACK_URL.');
  }
}

// ─────────────────────────────────────────────
// Setup Socket.IO
// ─────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
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
      : (payload && typeof payload === 'object' ? (payload.uid || payload.sub || payload.userId) : null);
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

  // Discussion sockets (channels/messages/presence) — firestoreClient used internally
  attachDiscussionSocketHandlers({ io, socket });
  attachWhiteboardSocketHandlers({ io, socket });
});

// ─────────────────────────────────────────────
// 1. Security
// ─────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));

// ─────────────────────────────────────────────
// 2. CORS — frontend origin + credentials
// ─────────────────────────────────────────────
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─────────────────────────────────────────────
// 3. Firebase token verification (global)
// Reads Authorization: Bearer <token> on every request.
// Sets req.firebaseUser if valid — routes can check this.
// Routes without auth simply ignore req.firebaseUser.
// ─────────────────────────────────────────────
app.use(verifyFirebaseToken);

// ─────────────────────────────────────────────
// 4. Parsing & Logging
// ─────────────────────────────────────────────
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '1mb' }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.warn('[HTTP] malformed JSON body', { path: req.originalUrl, method: req.method });
    return res.status(400).json({
      success: false,
      error: 'Malformed JSON body.',
      code: 'malformed_json',
    });
  }
  if (err.type === 'entity.too.large') {
    logger.warn('[HTTP] request body too large', { path: req.originalUrl, method: req.method });
    return res.status(413).json({
      success: false,
      error: 'Request body is too large.',
      code: 'payload_too_large',
    });
  }
  return next(err);
});
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
// 5. Session — for GitHub OAuth only
// GitHub OAuth uses the passport-github2 strategy which needs
// a session to persist the OAuth state between /login and /callback.
// Firebase Auth routes do NOT use sessions.
// ─────────────────────────────────────────────
app.use(session({
  name: 'connect.sid',
  secret: process.env.SESSION_SECRET || 'cloudiq-development-session-secret',
  resave: false,
  saveUninitialized: false,
  proxy: isProduction,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: isProduction ? 'none' : 'lax',
  },
}));

// ─────────────────────────────────────────────
// 6. Passport — for GitHub OAuth (Labs) only
// ─────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// ─────────────────────────────────────────────
// GitHub OAuth routes (Labs / Codespaces)
// ─────────────────────────────────────────────
app.use('/api/github', githubAuthRoutes);
app.use('/api/labs', labsRoutes);

// ─────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'CloudIQ backend running',
    auth: 'Firebase Auth',
    database: 'Firestore',
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
  });
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
//              LEGACY INLINE ADMIN APIs
// Kept for backward compat. The /api/admin/* routes
// in routes/admin.js are the canonical endpoints.
// ═════════════════════════════════════════════

/**
 * GET /api/user-role
 * Returns the user's email + isAdmin status.
 * Frontend calls this after login to decide which dashboard to show.
 */
app.get('/api/user-role', async (req, res) => {
  if (!req.firebaseUser) {
    return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
  }

  const { email } = extractUserInfo(req);

  if (!email) {
    return res.status(400).json({ success: false, error: 'No email found in token.' });
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
 * Adds a new admin. Only the super admin can call this.
 * Body: { "newAdminEmail": "admin@example.com" }
 */
app.post('/api/add-admin', async (req, res) => {
  try {
    if (!req.firebaseUser) {
      return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
    }

    const { email: callerEmail } = extractUserInfo(req);

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
 * Removes an admin email. Only the super admin can call this.
 * Body: { "adminEmail": "admin@example.com" }
 */
app.delete('/api/remove-admin', async (req, res) => {
  try {
    if (!req.firebaseUser) {
      return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
    }

    const { email: callerEmail } = extractUserInfo(req);

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
 * Returns all admins. Only accessible by the super admin.
 */
app.get('/api/list-admins', async (req, res) => {
  if (!req.firebaseUser) {
    return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Not logged in.' });
  }

  const { email: callerEmail } = extractUserInfo(req);

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
app.use('/api/brainstorm', brainstormRoutes);

// ─────────────────────────────────────────────
// 404 + Error Handlers
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: 'Route does not exist',
    method: req.method,
    path: req.path,
  });
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
// Start Server
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  logger.info(`[SERVER] Running on port ${PORT}`);
  logger.info(`[SERVER] Frontend origin ${FRONTEND_URL}`);
  logger.info('[AUTH] Firebase Auth active — JWT Bearer token verification enabled');
  logger.info('[DB] Firestore active — Cloudant removed');
  logMountedRoutes();
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
