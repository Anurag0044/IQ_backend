const { extractUserInfo } = require('./auth');

function sendError(res, status, error, message) {
  return res.status(status).json({
    success: false,
    error,
    message: message || error,
  });
}

function ensureGitHubOAuthConfigured(req, res, next) {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    console.warn('[GITHUB_AUTH] GitHub OAuth is not configured.');
    return sendError(res, 503, 'GitHub OAuth is not configured.');
  }
  return next();
}

function ensureGitHubConnected(req, res, next) {
  const token = req.session?.github?.accessToken;
  if (!token) {
    return sendError(res, 401, 'GitHub login required.', 'Connect GitHub before launching a lab.');
  }
  return next();
}

function getGitHubSession(req) {
  return req.session?.github || null;
}

function getAuthenticatedUserId(req) {
  const { userId } = extractUserInfo(req.user);
  return userId;
}

module.exports = {
  ensureGitHubOAuthConfigured,
  ensureGitHubConnected,
  getGitHubSession,
  getAuthenticatedUserId,
};
