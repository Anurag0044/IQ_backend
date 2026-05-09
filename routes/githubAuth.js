const express = require('express');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const {
  ensureAuthenticated,
} = require('../middleware/auth');
const {
  ensureGitHubOAuthConfigured,
} = require('../middleware/githubAuth');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
const CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || `${BACKEND_URL}/api/github/callback`;

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use('github-labs', new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: CALLBACK_URL,
  }, (accessToken, refreshToken, profile, done) => {
    return done(null, {
      id: profile.id,
      username: profile.username,
      displayName: profile.displayName,
      profileUrl: profile.profileUrl,
      accessToken,
    });
  }));

  console.log(`[GITHUB_AUTH] GitHub OAuth configured with callback ${CALLBACK_URL}`);
} else {
  console.warn('[GITHUB_AUTH] Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET; GitHub lab login disabled.');
}

router.get('/status', ensureAuthenticated, (req, res) => {
  const github = req.session?.github || null;
  return res.json({
    success: true,
    connected: Boolean(github?.accessToken),
    github: github ? {
      id: github.id,
      username: github.username,
      displayName: github.displayName,
      profileUrl: github.profileUrl,
      connectedAt: github.connectedAt,
    } : null,
  });
});

router.get('/login',
  ensureAuthenticated,
  ensureGitHubOAuthConfigured,
  (req, res, next) => {
    console.log('[GITHUB_AUTH] Starting GitHub OAuth connection.');
    return passport.authenticate('github-labs', {
      scope: ['codespace', 'read:user'],
      session: false,
      state: true,
    })(req, res, next);
  }
);

router.get('/callback',
  ensureGitHubOAuthConfigured,
  (req, res, next) => {
    passport.authenticate('github-labs', { session: false }, (err, githubProfile) => {
      if (err) {
        console.error('[GITHUB_AUTH] Callback error:', err.message || err);
        return res.redirect(`${FRONTEND_URL}/labs?github=error`);
      }

      if (!githubProfile?.accessToken) {
        console.warn('[GITHUB_AUTH] Callback did not return an access token.');
        return res.redirect(`${FRONTEND_URL}/labs?github=failed`);
      }

      req.session.github = {
        id: githubProfile.id,
        username: githubProfile.username,
        displayName: githubProfile.displayName,
        profileUrl: githubProfile.profileUrl,
        accessToken: githubProfile.accessToken,
        connectedAt: new Date().toISOString(),
      };

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[GITHUB_AUTH] Failed to save GitHub token in session:', saveErr.message);
          return res.redirect(`${FRONTEND_URL}/labs?github=session_error`);
        }

        console.log(`[GITHUB_AUTH] Connected GitHub account ${githubProfile.username || githubProfile.id}.`);
        return res.redirect(`${FRONTEND_URL}/labs?github=connected`);
      });
    })(req, res, next);
  }
);

router.post('/logout', ensureAuthenticated, (req, res) => {
  if (req.session) {
    delete req.session.github;
  }
  console.log('[GITHUB_AUTH] GitHub connection removed from session.');
  return res.json({ success: true, message: 'GitHub disconnected.' });
});

module.exports = router;
