// ============================================
// CloudIQ Backend - Main Server
// ============================================
// Complete auth flow:
//   Login:  Frontend → /auth/login → IBM App ID → /auth/callback → Frontend /dashboard
//   Logout: Frontend → /auth/logout → destroy session → Frontend /
//   Check:  Frontend → /auth/user → { loggedIn: true/false, user }

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { WebAppStrategy } = require('ibmcloud-appid');

const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
const authRoutes = require('./routes/auth');
const postsRoutes = require('./routes/posts');
const notificationsRoutes = require('./routes/notifications');
const voiceRoutes = require('./routes/voice');
const commentsRoutes = require('./routes/comments');
const friendsRoutes = require('./routes/friends');

const app = express();
const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

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
app.use(session({
  secret: process.env.SESSION_SECRET || 'cloudiq-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,          // false for localhost (HTTP, not HTTPS)
    httpOnly: true,         // JS cannot access cookie
    maxAge: 24 * 60 * 60 * 1000,  // 24 hours
    sameSite: 'lax',        // protects against CSRF
  },
}));

// ─────────────────────────────────────────────
// 5. Passport — MUST be after Session
// ─────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// IBM App ID strategy
passport.use(new WebAppStrategy({
  tenantId: process.env.APPID_TENANT_ID,
  clientId: process.env.APPID_CLIENT_ID,
  secret: process.env.APPID_SECRET,
  oauthServerUrl: process.env.APPID_OAUTH_SERVER_URL,
  redirectUri: process.env.APPID_REDIRECT_URI,
}));

// Store entire user object in session
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ═════════════════════════════════════════════
//              AUTH ROUTES
// ═════════════════════════════════════════════

/**
 * GET /auth/login
 * Step 1: Frontend sends user here
 * Step 2: Passport redirects to IBM App ID login page
 */
app.get('/auth/login',
  passport.authenticate(WebAppStrategy.STRATEGY_NAME, {
    forceLogin: true,
  })
);

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
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[AUTH] ❌ Session login error:', loginErr.message || loginErr);
        return res.redirect(FRONTEND_URL + '/?error=session_error');
      }

      // ✅ SUCCESS — redirect to frontend dashboard
      console.log('[AUTH] ✅ Login successful:', user.name || user.email || 'Unknown');
      console.log('[AUTH] ✅ Redirecting to:', FRONTEND_URL + '/dashboard');
      return res.redirect(FRONTEND_URL + '/dashboard');
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
  try { WebAppStrategy.logout(req); } catch (e) { /* ignore */ }

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
app.get('/auth/user', (req, res) => {
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

  // Sync user to database (creates them if they don't exist, updates lastLogin)
  const db = require('./utils/db');
  db.syncUser(user);

  const { checkAdminRole } = require('./middleware/auth');
  const isAdmin = checkAdminRole(user);

  return res.json({
    loggedIn: true,
    success: true,
    user: {
      name: user.name || user.given_name || 'User',
      email: user.email || user.emails?.[0]?.value || null,
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
app.get('/auth/status', (req, res) => {
  const authenticated = req.isAuthenticated ? req.isAuthenticated() : false;
  let isAdmin = false;
  if (authenticated && req.user) {
    const { checkAdminRole } = require('./middleware/auth');
    isAdmin = checkAdminRole(req.user);
  }
  res.json({ authenticated, isAdmin });
});

/**
 * GET /debug-user
 * Debug only — shows raw user object and role locations
 */
app.get('/debug-user', (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({
      loggedIn: false,
      message: 'Not logged in. Go to http://localhost:' + PORT + '/auth/login first.',
    });
  }
  const user = req.user;
  const roles = extractRoles(user);

  // Sync user here too just in case
  const db = require('./utils/db');
  db.syncUser(user);

  res.json({
    loggedIn: true,
    extractedRoles: roles,
    isAdmin: require('./middleware/auth').checkAdminRole(user),
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
//              API ROUTES
// ═════════════════════════════════════════════
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/voice', voiceRoutes);

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
  console.log('  Register this callback URL in IBM App ID:');
  console.log(`  → ${process.env.APPID_REDIRECT_URI}`);
  console.log('');
});

module.exports = app;
