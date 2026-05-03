// Re-export from the main auth middleware for backward compatibility
const { ensureAuthenticated, ensureAdmin, checkAdminRole, extractUserInfo } = require('./auth');

module.exports = {
  ensureAuthenticated,
  ensureAdmin,
  checkAdminRole,
  extractUserInfo,
};
