// ============================================
// CloudIQ Backend - App ID Configuration
// ============================================
// Centralizes IBM App ID setup for Passport.js

const passport = require('passport');
const { WebAppStrategy } = require('ibmcloud-appid');

/**
 * Initializes and configures IBM App ID with Passport.js
 * @param {Object} app - Express application instance
 */
function configureAppID(app) {
  // Initialize Passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Configure the WebAppStrategy for IBM App ID
  passport.use(
    new WebAppStrategy({
      tenantId: process.env.APPID_TENANT_ID,
      clientId: process.env.APPID_CLIENT_ID,
      secret: process.env.APPID_SECRET,
      oauthServerUrl: process.env.APPID_OAUTH_SERVER_URL,
      redirectUri: process.env.APPID_REDIRECT_URI,
    })
  );

  // Serialize user into session
  passport.serializeUser((user, done) => {
    done(null, user);
  });

  // Deserialize user from session
  passport.deserializeUser((user, done) => {
    done(null, user);
  });
}

module.exports = { configureAppID, WebAppStrategy };
