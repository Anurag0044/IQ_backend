// ============================================
// CloudIQ Backend - Session Configuration
// ============================================
// Configures express-session for secure session management
// FIXED: Added connect.sid as cookie name for broader compatibility

const session = require('express-session');
const { isProduction } = require('./env');

/**
 * Creates and returns session middleware configuration
 * @returns {Function} Express session middleware
 */
function configureSession() {
  return session({
    secret: process.env.SESSION_SECRET || 'cloudiq-development-session-secret',
    resave: false,
    saveUninitialized: false,
    proxy: isProduction,
    cookie: {
      secure: isProduction,                           // HTTPS only in production
      httpOnly: true,                                 // Prevents client-side JS access
      maxAge: 24 * 60 * 60 * 1000,                   // 24 hours
      sameSite: isProduction ? 'none' : 'lax',
    },
    // Use default 'connect.sid' cookie name for better Passport compatibility
    // Custom names can cause issues with some passport strategies
    name: 'connect.sid',
  });
}

module.exports = { configureSession };
