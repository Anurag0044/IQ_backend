// Re-export from the main auth middleware for backward compatibility
const {
  verifyFirebaseToken,
  ensureAuthenticated,
  ensureAdmin,
  checkAdminRole,
  checkAdminRoleSync,
  extractUserInfo,
} = require('./auth');

module.exports = {
  verifyFirebaseToken,
  ensureAuthenticated,
  ensureAdmin,
  checkAdminRole,
  checkAdminRoleSync,
  extractUserInfo,
};
