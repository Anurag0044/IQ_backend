const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = process.env.GITHUB_API_VERSION || '2026-03-10';

function githubHeaders(accessToken) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

function apiErrorMessage(err) {
  return err.response?.data?.message || err.message || 'GitHub API request failed';
}

function classifyGitHubError(err, fallbackCode = 'GITHUB_ERROR') {
  const status = err.response?.status || err.statusCode;
  const message = apiErrorMessage(err);
  const documentationUrl = err.response?.data?.documentation_url || '';

  if (status === 401) {
    return { statusCode: 401, code: 'GITHUB_AUTH_REQUIRED', message: 'Connect GitHub before launching this lab.' };
  }
  if (status === 404) {
    return { statusCode: 404, code: 'REPO_NOT_FOUND', message: 'Repository not found or inaccessible.' };
  }
  if (status === 403 && /rate limit|api rate limit|secondary rate/i.test(message)) {
    return { statusCode: 429, code: 'GITHUB_RATE_LIMIT', message: 'GitHub rate limit reached. Please retry later.' };
  }
  if (
    status === 403 &&
    (/saml|single sign-on|sso|oauth app access restricted|resource protected by organization/i.test(message) ||
      /saml|sso|oauth_app_access_restrictions/i.test(documentationUrl))
  ) {
    return { statusCode: 403, code: 'ORG_RESTRICTED', message: 'Organization approval required' };
  }
  if (status === 403 && /codespaces.*disabled|codespaces is disabled|disabled for this repository/i.test(message)) {
    return { statusCode: 403, code: 'CODESPACES_UNAVAILABLE', message: 'Codespaces is unavailable for this repository.' };
  }
  if (status === 403) {
    return { statusCode: 403, code: 'REPO_ACCESS_DENIED', message: message || 'GitHub repository access denied.' };
  }
  if (status === 422 && /codespace|codespaces/i.test(message)) {
    return { statusCode: 422, code: 'CODESPACES_UNAVAILABLE', message: message || 'Codespaces is unavailable for this repository.' };
  }

  return { statusCode: status || 502, code: fallbackCode, message };
}

function isRecoverableCodespaceError(err) {
  const status = err.response?.status || err.statusCode;
  return status === 401 || status === 403 || status === 404;
}

function recoverableCodespaceResult(action, codespaceName, err) {
  const status = err.response?.status || err.statusCode;
  const message = apiErrorMessage(err);
  const alreadyRemoved = status === 404;

  if (alreadyRemoved) {
    logger.warn(`[LABS][GITHUB] Codespace ${codespaceName} was already gone during ${action}.`);
  } else {
    logger.warn(`[LABS][GITHUB] Recoverable codespace ${action} failure (${status}): ${message}`);
  }

  return {
    ok: false,
    recoverable: true,
    alreadyRemoved,
    status,
    message,
  };
}

function parseGitHubRepoUrl(repoUrl) {
  if (typeof repoUrl !== 'string') return null;

  let trimmed = repoUrl.trim();
  if (trimmed.length > 300) return null;
  if (/^github\.com\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    return null;
  }

  const parts = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const safeSegment = /^[A-Za-z0-9_.-]+$/;

  if (!safeSegment.test(owner) || !safeSegment.test(repo)) return null;

  let ref = null;
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
    ref = parts.slice(3).join('/');
  }

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    ref,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
  };
}

const parsePublicGitHubRepoUrl = parseGitHubRepoUrl;

async function fetchRepositoryDetails(accessToken, repoRef) {
  logger.debug(`[LABS][GITHUB] Fetching repository ${repoRef.owner}/${repoRef.repo}`);
  try {
    const response = await axios.get(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}`,
      { headers: githubHeaders(accessToken), timeout: 15000 }
    );
    return response.data;
  } catch (err) {
    const classified = classifyGitHubError(err, 'REPO_VALIDATION_FAILED');
    logger.warn('[LABS][GITHUB] Repository fetch failed', {
      status: classified.statusCode,
      code: classified.code,
      repo: repoRef.fullName || `${repoRef.owner}/${repoRef.repo}`,
    });
    const wrapped = new Error(classified.message);
    wrapped.statusCode = classified.statusCode;
    wrapped.code = classified.code;
    throw wrapped;
  }
}

async function listUserRepositories(accessToken, options = {}) {
  if (!accessToken) {
    const err = new Error('Connect GitHub before listing repositories.');
    err.statusCode = 401;
    err.code = 'GITHUB_AUTH_REQUIRED';
    throw err;
  }

  const perPage = Math.max(1, Math.min(100, Number(options.perPage || 100)));
  const page = Math.max(1, Math.min(10, Number(options.page || 1)));
  try {
    const response = await axios.get(`${GITHUB_API_BASE}/user/repos`, {
      headers: githubHeaders(accessToken),
      timeout: 15000,
      params: {
        visibility: 'all',
        affiliation: 'owner,collaborator,organization_member',
        sort: 'updated',
        direction: 'desc',
        per_page: perPage,
        page,
      },
    });
    return response.data;
  } catch (err) {
    const classified = classifyGitHubError(err, 'GITHUB_REPOS_FAILED');
    const wrapped = new Error(classified.message);
    wrapped.statusCode = classified.statusCode;
    wrapped.code = classified.code;
    throw wrapped;
  }
}

async function createCodespace(accessToken, repoRef, options = {}) {
  if (!accessToken) {
    const err = new Error('Connect GitHub before launching this lab.');
    err.statusCode = 401;
    err.code = 'GITHUB_AUTH_REQUIRED';
    throw err;
  }

  logger.info(`[LABS][GITHUB] Creating codespace for ${repoRef.owner}/${repoRef.repo}`);
  try {
    const body = {
      idle_timeout_minutes: options.idleTimeoutMinutes || 30,
    };
    if (options.ref) body.ref = options.ref;
    if (options.displayName) body.display_name = options.displayName;

    const response = await axios.post(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}/codespaces`,
      body,
      { headers: githubHeaders(accessToken), timeout: 30000 }
    );
    return response.data;
  } catch (err) {
    const classified = classifyGitHubError(err, 'CODESPACE_CREATE_FAILED');
    if (classified.code === 'ORG_RESTRICTED') {
      logger.info('[LABS] org restriction detected', { repo: repoRef.fullName || `${repoRef.owner}/${repoRef.repo}` });
    } else {
      logger.warn('[LABS][GITHUB] Codespace create failed', {
        status: classified.statusCode,
        code: classified.code,
        repo: repoRef.fullName || `${repoRef.owner}/${repoRef.repo}`,
      });
    }
    const wrapped = new Error(classified.message);
    wrapped.statusCode = classified.statusCode;
    wrapped.code = classified.code;
    throw wrapped;
  }
}

function validateCodespaceDeleteInput(accessToken, codespaceName) {
  if (!codespaceName || typeof codespaceName !== 'string') {
    const err = new Error('Codespace name is required.');
    err.statusCode = 400;
    throw err;
  }

  if (!accessToken) {
    const err = new Error('GitHub access token is required.');
    err.statusCode = 401;
    throw err;
  }
}

async function fetchCodespace(accessToken, codespaceName, options = {}) {
  logger.debug(`[LABS][GITHUB] Fetching codespace ${codespaceName}`);
  try {
    validateCodespaceDeleteInput(accessToken, codespaceName);
    const response = await axios.get(
      `${GITHUB_API_BASE}/user/codespaces/${encodeURIComponent(codespaceName)}`,
      { headers: githubHeaders(accessToken), timeout: 15000 }
    );
    return {
      ok: true,
      recoverable: false,
      data: response.data,
    };
  } catch (err) {
    if (options.recoverable && isRecoverableCodespaceError(err)) {
      return recoverableCodespaceResult('fetch', codespaceName, err);
    }

    const status = err.response?.status;
    const message = apiErrorMessage(err);
    logger.error(`[LABS][GITHUB] Codespace fetch failed (${status || 'no-status'}): ${message}`);
    const wrapped = new Error(message);
    wrapped.statusCode = status === 401 ? 401 : status === 403 ? 403 : status === 404 ? 404 : 502;
    throw wrapped;
  }
}

async function stopCodespace(accessToken, codespaceName, options = {}) {
  logger.info(`[LABS][GITHUB] Stopping codespace ${codespaceName}`);
  try {
    validateCodespaceDeleteInput(accessToken, codespaceName);
    await axios.post(
      `${GITHUB_API_BASE}/user/codespaces/${encodeURIComponent(codespaceName)}/stop`,
      {},
      { headers: githubHeaders(accessToken), timeout: 20000 }
    );
    return {
      ok: true,
      recoverable: false,
    };
  } catch (err) {
    if (options.recoverable && isRecoverableCodespaceError(err)) {
      return recoverableCodespaceResult('stop', codespaceName, err);
    }

    const status = err.response?.status;
    const message = apiErrorMessage(err);
    logger.error(`[LABS][GITHUB] Codespace stop failed (${status || 'no-status'}): ${message}`);
    const wrapped = new Error(message);
    wrapped.statusCode = status === 401 ? 401 : status === 403 ? 403 : status === 404 ? 404 : 502;
    throw wrapped;
  }
}

async function deleteCodespace(accessToken, codespaceName, options = {}) {
  logger.info(`[LABS][GITHUB] Deleting codespace ${codespaceName}`);
  try {
    validateCodespaceDeleteInput(accessToken, codespaceName);
    await axios.delete(
      `${GITHUB_API_BASE}/user/codespaces/${encodeURIComponent(codespaceName)}`,
      { headers: githubHeaders(accessToken), timeout: 20000 }
    );
    return {
      ok: true,
      recoverable: false,
      alreadyRemoved: false,
    };
  } catch (err) {
    if (options.recoverable && isRecoverableCodespaceError(err)) {
      return recoverableCodespaceResult('delete', codespaceName, err);
    }

    const status = err.response?.status;
    const message = apiErrorMessage(err);
    logger.error(`[LABS][GITHUB] Codespace delete failed (${status || 'no-status'}): ${message}`);
    const wrapped = new Error(message);
    wrapped.statusCode = status === 401 ? 401 : status === 403 ? 403 : 502;
    throw wrapped;
  }
}

function getTokenEncryptionKey() {
  const source = process.env.LAB_TOKEN_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!source) {
    const err = new Error('LAB_TOKEN_ENCRYPTION_KEY or SESSION_SECRET is required for lab cleanup tokens.');
    err.statusCode = 500;
    throw err;
  }
  return crypto.createHash('sha256').update(source).digest();
}

function encryptAccessToken(accessToken) {
  if (!accessToken) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getTokenEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptAccessToken(encryptedToken) {
  if (!encryptedToken) return null;
  const [ivPart, tagPart, encryptedPart] = encryptedToken.split(':');
  if (!ivPart || !tagPart || !encryptedPart) return null;

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getTokenEncryptionKey(),
    Buffer.from(ivPart, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = {
  parseGitHubRepoUrl,
  parsePublicGitHubRepoUrl,
  listUserRepositories,
  fetchRepositoryDetails,
  fetchCodespace,
  createCodespace,
  stopCodespace,
  deleteCodespace,
  isRecoverableCodespaceError,
  encryptAccessToken,
  decryptAccessToken,
};
