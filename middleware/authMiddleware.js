// Re-export from the main auth middleware for backward compatibility
const {
  ensureAuthenticated,
  ensureAdmin,
  checkAdminRole,
  checkAdminRoleSync,
  extractUserInfo,
} = require('./auth');

module.exports = {
  ensureAuthenticated,
  ensureAdmin,
  checkAdminRole,
  checkAdminRoleSync,
  extractUserInfo,
};
