const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cloudant = require('../services/cloudantClient');
const { ensureAuthenticated } = require('../middleware/auth');
const {
  ensureGitHubConnected,
  getGitHubSession,
  getAuthenticatedUserId,
} = require('../middleware/githubAuth');
const {
  parsePublicGitHubRepoUrl,
  fetchRepositoryDetails,
  fetchCodespace,
  createCodespace,
  stopCodespace,
  deleteCodespace,
  encryptAccessToken,
  decryptAccessToken,
} = require('../services/githubCodespacesService');
const logger = require('../utils/logger');

const router = express.Router();
const DB_NAME = 'lab_sessions';
const LAB_TTL_MINUTES = Number(process.env.LAB_TTL_MINUTES || 30);
const LAB_NAME_MAX_LENGTH = 48;
const NON_BLOCKING_LAB_STATUSES = new Set(['deleted', 'expired', 'cleanup_failed']);

router.use(ensureAuthenticated);

function apiSuccess(res, status, payload) {
  return res.status(status).json({ success: true, ...payload });
}

function apiError(res, status, error, message) {
  return res.status(status).json({
    success: false,
    error,
    message: message || error,
  });
}

function cloudantErrorDetails(err) {
  const status = err.status || err.statusCode || err.code || 'no-status';
  const message = err.message || 'Cloudant request failed';
  return `${status}: ${message}`;
}

function sanitizeLab(lab) {
  if (!lab) return null;
  const {
    github_access_token_encrypted: _token,
    _rev: _rev,
    cleanup_error,
    ...safe
  } = lab;

  if (cleanup_error) safe.cleanup_error = cleanup_error;
  safe.display_name = lab.codespace_display_name || lab.lab_name || lab.codespace_name || null;
  return safe;
}

async function findLabsForUser(userId) {
  const response = await cloudant.postFind({
    db: DB_NAME,
    selector: { user_id: userId },
    limit: 100,
  });
  return response.result.docs || [];
}

async function findActiveLabsForUser(userId) {
  const response = await cloudant.postFind({
    db: DB_NAME,
    selector: {
      user_id: userId,
      status: 'active',
    },
    limit: 100,
  });
  return response.result.docs || [];
}

async function findActiveLabForUser(userId) {
  const docs = await findActiveLabsForUser(userId);
  return docs.find((lab) => lab.active !== false) || null;
}

async function findLabForUser(userId, labIdOrCodespaceName) {
  const response = await cloudant.postFind({
    db: DB_NAME,
    selector: {
      user_id: userId,
      $or: [
        { _id: labIdOrCodespaceName },
        { codespace_name: labIdOrCodespaceName },
      ],
    },
    limit: 1,
  });
  return (response.result.docs || [])[0] || null;
}

async function fetchLabDocument(labId) {
  const response = await cloudant.getDocument({ db: DB_NAME, docId: labId });
  return response.result;
}

function isExpired(lab) {
  return lab?.expires_at && new Date(lab.expires_at).getTime() <= Date.now();
}

function isBlockingActiveLab(lab) {
  return Boolean(
    lab &&
    lab.status === 'active' &&
    lab.active !== false &&
    !NON_BLOCKING_LAB_STATUSES.has(lab.status)
  );
}

async function releaseExpiredActiveLabs(activeLabs) {
  for (const lab of activeLabs) {
    if (isBlockingActiveLab(lab) && isExpired(lab)) {
      logger.debug(`[LABS] Existing active lab ${lab._id} is expired; marking expired before creating a new one.`);
      await markLabStatus(lab, 'expired', { expired_at: new Date().toISOString() });
      logger.debug('[LABS] active lab released');
    }
  }
}

function normalizeLabName(value, fallback) {
  const source = typeof value === 'string' && value.trim() ? value : fallback;
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return normalized.slice(0, LAB_NAME_MAX_LENGTH).replace(/-+$/g, '');
}

function resolveLabName(input, repoRef) {
  const provided = typeof input === 'string';
  if (provided && !input.trim()) {
    const err = new Error('Lab name cannot be empty.');
    err.statusCode = 400;
    throw err;
  }

  if (provided && input.trim().length > 100) {
    const err = new Error('Lab name is too long.');
    err.statusCode = 400;
    throw err;
  }

  const sanitized = provided
    ? normalizeLabName(input, '')
    : normalizeLabName('', `cloudiq-${repoRef.repo}`);

  if (!sanitized) {
    const err = new Error('Lab name cannot be empty.');
    err.statusCode = 400;
    throw err;
  }

  const prefixed = sanitized.startsWith('cloudiq-') ? sanitized : `cloudiq-${sanitized}`;
  const displayName = prefixed.slice(0, LAB_NAME_MAX_LENGTH).replace(/-+$/g, '');

  return {
    labName: sanitized,
    displayName,
  };
}

async function markLabStatus(lab, status, extra = {}) {
  const updated = {
    ...lab,
    ...extra,
    status,
    active: status === 'active',
    updated_at: new Date().toISOString(),
  };

  await cloudant.putDocument({
    db: DB_NAME,
    docId: lab._id,
    document: updated,
  });

  return updated;
}

function getLabDeletionToken(req, lab) {
  const sessionToken = getGitHubSession(req)?.accessToken;
  if (sessionToken) return sessionToken;

  try {
    return decryptAccessToken(lab.github_access_token_encrypted);
  } catch (err) {
    logger.warn(`[LABS] Could not decrypt stored GitHub token for lab ${lab._id}: ${err.message}`);
    return null;
  }
}

async function softDeleteLabDocument(lab, status, extra = {}) {
  const freshLab = await fetchLabDocument(lab._id).catch((err) => {
    if (err.status === 404 || err.statusCode === 404) return null;
    throw err;
  });

  if (!freshLab) {
    logger.debug(`[LABS][CLOUDANT] lab document already removed: ${lab._id}`);
    return {
      ...lab,
      ...extra,
      status,
      active: false,
      codespace_name: null,
      web_url: null,
      session_data: null,
      codespace_session: null,
      github_access_token_encrypted: null,
      deleted_at: status === 'deleted' ? new Date().toISOString() : lab.deleted_at,
      updated_at: new Date().toISOString(),
    };
  }

  const updated = {
    ...freshLab,
    ...extra,
    status,
    active: false,
    codespace_name: null,
    web_url: null,
    session_data: null,
    codespace_session: null,
    github_access_token_encrypted: null,
    cleanup_error: extra.cleanup_error || undefined,
    deleted_at: status === 'deleted' ? new Date().toISOString() : freshLab.deleted_at,
    expired_at: status === 'expired' ? new Date().toISOString() : freshLab.expired_at,
    updated_at: new Date().toISOString(),
  };

  await cloudant.putDocument({
    db: DB_NAME,
    docId: freshLab._id,
    document: updated,
  });

  logger.debug('[LABS][CLOUDANT] soft delete fallback used');
  logger.debug('[LABS] active lab released');
  return updated;
}

async function removeLabDocument(lab, status = 'deleted', extra = {}) {
  logger.debug('[LABS][CLOUDANT] removing lab document');
  logger.debug('[LABS][CLOUDANT] deleting lab document');

  let lastDeleteError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const freshLab = await fetchLabDocument(lab._id);
      await cloudant.deleteDocument({
        db: DB_NAME,
        docId: freshLab._id,
        rev: freshLab._rev,
      });

      logger.debug('[LABS][CLOUDANT] lab document removed');
      logger.debug('[LABS] active lab released');
      return {
        ...freshLab,
        ...extra,
        status,
        active: false,
        codespace_name: null,
        web_url: null,
        session_data: null,
        codespace_session: null,
        github_access_token_encrypted: null,
        deleted_at: status === 'deleted' ? new Date().toISOString() : freshLab.deleted_at,
        updated_at: new Date().toISOString(),
      };
    } catch (err) {
      if (err.status === 404 || err.statusCode === 404) {
        logger.debug(`[LABS][CLOUDANT] lab document already removed: ${lab._id}`);
        logger.debug('[LABS] active lab released');
        return {
          ...lab,
          ...extra,
          status,
          active: false,
          codespace_name: null,
          web_url: null,
          session_data: null,
          codespace_session: null,
          github_access_token_encrypted: null,
          deleted_at: status === 'deleted' ? new Date().toISOString() : lab.deleted_at,
          updated_at: new Date().toISOString(),
        };
      }

      lastDeleteError = err;
      logger.warn(`[LABS][CLOUDANT] hard delete attempt ${attempt} failed for ${lab._id}: ${cloudantErrorDetails(err)}`);
    }
  }

  return softDeleteLabDocument(lab, status, {
    ...extra,
    cleanup_error: extra.cleanup_error || cloudantErrorDetails(lastDeleteError),
  });
}

async function destroyCodespaceForLab(accessToken, lab) {
  const codespaceName = lab.codespace_name;

  if (!codespaceName) {
    logger.warn(`[LABS] Lab ${lab._id} has no codespace name; skipping GitHub cleanup.`);
    logger.debug('[LABS] codespace already removed');
    return {
      fetched: false,
      stopped: false,
      deleted: false,
      alreadyRemoved: true,
    };
  }

  let codespaceResult = null;
  try {
    codespaceResult = await fetchCodespace(accessToken, codespaceName, { recoverable: true });
  } catch (err) {
    if (err.statusCode === 401) {
      logger.warn(`[LABS] Recoverable GitHub fetch failure for ${codespaceName}: ${err.message}`);
      codespaceResult = { ok: false, recoverable: true, alreadyRemoved: false, status: 401, message: err.message };
    } else {
      throw err;
    }
  }

  if (codespaceResult.alreadyRemoved) {
    logger.debug('[LABS] codespace already removed');
    return {
      fetched: false,
      stopped: false,
      deleted: false,
      alreadyRemoved: true,
      warning: codespaceResult.message,
    };
  }

  const state = codespaceResult.data?.state;
  const shouldStop = codespaceResult.ok && !['Shutdown', 'ShuttingDown'].includes(state);
  if (shouldStop) {
    logger.debug('[LABS] stopping codespace...');
    const stopResult = await stopCodespace(accessToken, codespaceName, { recoverable: true });
    if (stopResult.recoverable) {
      logger.warn(`[LABS] Recoverable GitHub stop failure for ${codespaceName}: ${stopResult.message}`);
      if (stopResult.alreadyRemoved) {
        logger.debug('[LABS] codespace already removed');
        return {
          fetched: true,
          stopped: false,
          deleted: false,
          alreadyRemoved: true,
          warning: stopResult.message,
        };
      }
    }
  }

  logger.info('[LABS] deleting codespace...');
  const deleteResult = await deleteCodespace(accessToken, codespaceName, { recoverable: true });
  if (deleteResult.ok) {
    logger.info('[LABS] codespace deleted successfully');
  } else if (deleteResult.alreadyRemoved) {
    logger.debug('[LABS] codespace already removed');
  } else if (deleteResult.recoverable) {
    logger.warn(`[LABS] Recoverable GitHub delete failure for ${codespaceName}: ${deleteResult.message}`);
  }

  return {
    fetched: Boolean(codespaceResult.ok),
    stopped: Boolean(shouldStop),
    deleted: Boolean(deleteResult.ok),
    alreadyRemoved: Boolean(deleteResult.alreadyRemoved),
    warning: deleteResult.recoverable ? deleteResult.message : codespaceResult.message,
  };
}

async function destroyLabSession(req, lab, status = 'deleted') {
  const accessToken = getLabDeletionToken(req, lab);
  let githubCleanup = null;

  try {
    githubCleanup = await destroyCodespaceForLab(accessToken, lab);
  } catch (err) {
    logger.warn(`[LABS] GitHub cleanup failed for lab ${lab._id}; clearing Cloudant session anyway: ${err.message}`);
    githubCleanup = { warning: err.message };
  }

  const timestampField = status === 'expired' ? 'expired_at' : 'deleted_at';
  const updated = await removeLabDocument(lab, status, {
    [timestampField]: new Date().toISOString(),
    github_cleanup_warning: githubCleanup?.warning || undefined,
  });

  logger.info('[LABS] lab fully destroyed');
  return updated;
}

router.get('/', async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return apiError(res, 401, 'Unauthorized', 'No authenticated user id found.');

  try {
    logger.debug(`[LABS] Listing labs for user ${userId}`);
    const labs = await findLabsForUser(userId);
    const activeLab = labs.find((lab) => isBlockingActiveLab(lab)) || null;
    return apiSuccess(res, 200, {
      data: labs.map(sanitizeLab),
      activeLab: sanitizeLab(activeLab),
      githubConnected: Boolean(req.session?.github?.accessToken),
    });
  } catch (err) {
    logger.error('[LABS] Failed to list labs:', err.message);
    return apiError(res, 500, 'Failed to list labs.');
  }
});

router.post('/create', ensureGitHubConnected, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const githubSession = getGitHubSession(req);

  if (!userId) return apiError(res, 401, 'Unauthorized', 'No authenticated user id found.');

  try {
    logger.debug('[LABS] checking active lab state');
    const repoRef = parsePublicGitHubRepoUrl(req.body?.repoUrl);
    if (!repoRef) {
      return apiError(res, 400, 'Invalid GitHub repo URL.', 'Use a public HTTPS GitHub URL like https://github.com/owner/repo.');
    }
    const resolvedName = resolveLabName(req.body?.labName, repoRef);
    logger.debug(`[LABS] custom lab name accepted: ${resolvedName.displayName}`);

    const activeLabs = await findActiveLabsForUser(userId);
    const blockingActiveLab = activeLabs.find((lab) => isBlockingActiveLab(lab) && !isExpired(lab));
    if (blockingActiveLab) {
      return apiError(res, 409, 'You already have an active lab.', 'Delete the current lab or wait for it to expire.');
    }

    await releaseExpiredActiveLabs(activeLabs);

    const repo = await fetchRepositoryDetails(githubSession.accessToken, repoRef);
    if (repo.private) {
      return apiError(res, 403, 'Private repositories are not allowed.');
    }

    logger.info('[LABS] creating new lab');
    const codespace = await createCodespace(githubSession.accessToken, repoRef, {
      idleTimeoutMinutes: LAB_TTL_MINUTES,
      displayName: resolvedName.displayName,
    });
    logger.info('[LABS] codespace created successfully');

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + LAB_TTL_MINUTES * 60 * 1000);
    const lab = {
      _id: uuidv4(),
      user_id: userId,
      lab_name: resolvedName.labName,
      codespace_display_name: codespace.display_name || resolvedName.displayName,
      repo_url: repoRef.normalizedUrl,
      repo_name: repo.full_name,
      codespace_name: codespace.name,
      web_url: codespace.web_url,
      status: 'active',
      active: true,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      github_user_id: githubSession.id,
      github_username: githubSession.username,
      github_access_token_encrypted: encryptAccessToken(githubSession.accessToken),
    };

    await cloudant.postDocument({ db: DB_NAME, document: lab });
    logger.info(`[LABS] Created lab ${lab._id} for ${userId}: ${lab.codespace_name}`);

    return apiSuccess(res, 201, {
      data: sanitizeLab(lab),
      web_url: lab.web_url,
      message: 'Lab created.',
    });
  } catch (err) {
    logger.error('[LABS] Failed to create lab:', err.message);
    return apiError(res, err.statusCode || 500, 'Failed to create lab.', err.message);
  }
});

router.delete('/:labId', async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return apiError(res, 401, 'Unauthorized', 'No authenticated user id found.');

  try {
    const labId = String(req.params.labId || '').trim();
    if (!labId) return apiError(res, 400, 'Lab id is required.');

    const lab = await findLabForUser(userId, labId);
    if (!lab) {
      return apiError(res, 404, 'Lab not found.');
    }

    if (lab.status === 'deleted' && !lab.codespace_name) {
      return apiSuccess(res, 200, {
        data: sanitizeLab(lab),
        message: 'Lab already deleted.',
      });
    }

    const updated = await destroyLabSession(req, lab, 'deleted');

    logger.info(`[LABS] Deleted lab ${lab._id} for ${userId}.`);
    return apiSuccess(res, 200, {
      data: sanitizeLab(updated),
      message: 'Lab deleted.',
    });
  } catch (err) {
    logger.error('[LABS] Failed to delete lab:', err.message);
    return apiError(res, err.statusCode || 500, 'Failed to delete lab.', err.message);
  }
});

router.delete('/', async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return apiError(res, 401, 'Unauthorized', 'No authenticated user id found.');

  try {
    const lab = await findActiveLabForUser(userId);
    if (!lab) return apiError(res, 404, 'No active lab found.');

    const updated = await destroyLabSession(req, lab, 'deleted');

    logger.info(`[LABS] Deleted active lab ${lab._id} for ${userId}.`);
    return apiSuccess(res, 200, {
      data: sanitizeLab(updated),
      message: 'Lab deleted.',
    });
  } catch (err) {
    logger.error('[LABS] Failed to delete active lab:', err.message);
    return apiError(res, err.statusCode || 500, 'Failed to delete lab.', err.message);
  }
});

module.exports = router;

