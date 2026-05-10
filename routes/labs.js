const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { ensureAuthenticated } = require('../middleware/auth');
const {
  getGitHubSession,
  getAuthenticatedUserId,
} = require('../middleware/githubAuth');
const {
  parseGitHubRepoUrl,
  fetchRepositoryDetails,
  fetchCodespace,
  createCodespace,
  stopCodespace,
  deleteCodespace,
} = require('../services/githubCodespacesService');
const firebaseService = require('../services/firebaseService');
const logger = require('../utils/logger');

const router = express.Router();
const LAB_TTL_MINUTES = Number(process.env.LAB_TTL_MINUTES || 30);
const LAB_NAME_MAX_LENGTH = 48;
const NON_BLOCKING_LAB_STATUSES = new Set(['deleted', 'expired', 'cleanup_failed']);

router.use(ensureAuthenticated);

function apiSuccess(res, status, payload) {
  return res.status(status).json({ success: true, ...payload });
}

function apiError(res, status, error, message, code) {
  return res.status(status).json({
    success: false,
    code,
    error,
    message: message || error,
  });
}

function labError(res, err, fallbackMessage = 'Failed to process lab request.') {
  const status = err.statusCode || err.status || 500;
  return apiError(
    res,
    status,
    err.message || fallbackMessage,
    err.message || fallbackMessage,
    err.code || 'LAB_REQUEST_FAILED'
  );
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
  safe.display_name = lab.codespace_display_name || lab.displayName || lab.lab_name || lab.codespaceName || lab.codespace_name || null;
  safe.labId = lab._id || lab.id;
  safe.codespaceName = lab.codespaceName || lab.codespace_name || null;
  safe.webUrl = lab.webUrl || lab.web_url || null;
  safe.expiresAt = lab.expiresAt || lab.expires_at || null;
  return safe;
}

async function findLabsForUser(userId) {
  return firebaseService.getUserLabs(userId, { limit: 100 });
}

async function findActiveLabsForUser(userId) {
  return firebaseService.getUserLabs(userId, { status: 'active', active: true, limit: 100 });
}

async function findActiveLabForUser(userId) {
  const docs = await findActiveLabsForUser(userId);
  return docs.find((lab) => lab.active !== false) || null;
}

async function findLabForUser(userId, labIdOrCodespaceName) {
  const direct = await firebaseService.getLabById(labIdOrCodespaceName);
  if (direct && (direct.userId === userId || direct.user_id === userId)) return direct;
  const labs = await findLabsForUser(userId);
  return labs.find((lab) =>
    lab.codespaceName === labIdOrCodespaceName ||
    lab.codespace_name === labIdOrCodespaceName
  ) || null;
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
  return firebaseService.updateLab(lab._id || lab.id, {
    ...extra,
    status,
    active: status === 'active',
    updated_at: new Date().toISOString(),
  });
}

async function softDeleteLabDocument(lab, status, extra = {}) {
  const now = new Date().toISOString();
  const updated = {
    ...lab,
    ...extra,
    status,
    active: false,
    codespace_name: null,
    codespaceName: null,
    web_url: null,
    webUrl: null,
    session_data: null,
    codespace_session: null,
    cleanup_error: extra.cleanup_error || undefined,
    deleted_at: status === 'deleted' ? now : lab.deleted_at,
    deletedAt: status === 'deleted' ? now : lab.deletedAt,
    expired_at: status === 'expired' ? now : lab.expired_at,
    expiresAt: status === 'expired' ? lab.expiresAt : lab.expiresAt,
    updated_at: now,
    updatedAt: now,
  };

  const saved = status === 'deleted'
    ? await firebaseService.deleteLab(lab._id || lab.id, updated)
    : await firebaseService.updateLab(lab._id || lab.id, updated);
  logger.debug('[LABS][FIRESTORE] lab soft-deleted');
  logger.debug('[LABS] active lab released');
  return saved;
}

async function removeLabDocument(lab, status = 'deleted', extra = {}) {
  return softDeleteLabDocument(lab, status, extra);
}

async function destroyCodespaceForLab(accessToken, lab) {
  const codespaceName = lab.codespaceName || lab.codespace_name;

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
  const accessToken = getGitHubSession(req)?.accessToken || null;
  let githubCleanup = null;

  try {
    githubCleanup = await destroyCodespaceForLab(accessToken, lab);
  } catch (err) {
    logger.warn(`[LABS] GitHub cleanup failed for lab ${lab._id}; clearing Firestore session anyway: ${err.message}`);
    githubCleanup = { warning: err.message };
  }

  const timestampField = status === 'expired' ? 'expired_at' : 'deleted_at';
  const updated = await removeLabDocument(lab, status, {
    [timestampField]: new Date().toISOString(),
    github_cleanup_warning: githubCleanup?.warning || undefined,
  });

  await firebaseService.updateLabSession(lab.sessionId || lab.session_id || (lab._id || lab.id), {
    labId: lab._id || lab.id,
    userId: lab.userId || lab.user_id,
    status,
    endedAt: new Date().toISOString(),
  }).catch((err) => {
    logger.warn('[LABS][FIRESTORE] Failed to close lab session:', err.message);
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

router.post('/create', async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const githubSession = getGitHubSession(req);

  if (!userId) return apiError(res, 401, 'Unauthorized', 'No authenticated user id found.');

  try {
    logger.debug('[LABS] checking active lab state');
    const repoRef = parseGitHubRepoUrl(req.body?.repoUrl);
    if (!repoRef) {
      return apiError(
        res,
        400,
        'Invalid GitHub repo URL.',
        'Use a valid HTTPS GitHub repository URL like https://github.com/owner/repo.',
        'INVALID_REPO_URL'
      );
    }
    const resolvedName = resolveLabName(req.body?.labName, repoRef);
    logger.debug(`[LABS] custom lab name accepted: ${resolvedName.displayName}`);

    const activeLabs = await findActiveLabsForUser(userId);
    const blockingActiveLab = activeLabs.find((lab) => isBlockingActiveLab(lab) && !isExpired(lab));
    if (blockingActiveLab) {
      logger.warn('[LABS] duplicate active lab blocked', { userId, labId: blockingActiveLab._id || blockingActiveLab.id });
      return apiError(
        res,
        409,
        'You already have an active lab.',
        'Delete the current lab or wait for it to expire.',
        'DUPLICATE_ACTIVE_LAB'
      );
    }

    await releaseExpiredActiveLabs(activeLabs);

    let repo;
    try {
      repo = await fetchRepositoryDetails(githubSession?.accessToken || null, repoRef);
    } catch (err) {
      if (!githubSession?.accessToken && err.code === 'REPO_NOT_FOUND') {
        return apiError(
          res,
          401,
          'GitHub login required.',
          'Connect GitHub to launch private or restricted repositories.',
          'PRIVATE_REPO_AUTH_REQUIRED'
        );
      }
      return labError(res, err, 'Repository validation failed.');
    }

    if (!githubSession?.accessToken) {
      return apiError(
        res,
        401,
        'GitHub login required.',
        repo.private
          ? 'Connect GitHub to launch private repositories.'
          : 'Connect GitHub to create a Codespace for this repository.',
        'GITHUB_AUTH_REQUIRED'
      );
    }

    const requestedRef = String(req.body?.branch || req.body?.ref || repoRef.ref || repo.default_branch || '').trim();
    const codespaceRef = requestedRef || repo.default_branch || undefined;

    logger.info('[LABS] creating codespace', {
      repo: repo.full_name,
      visibility: repo.visibility || (repo.private ? 'private' : 'public'),
    });
    const codespace = await createCodespace(githubSession.accessToken, repoRef, {
      idleTimeoutMinutes: LAB_TTL_MINUTES,
      displayName: resolvedName.displayName,
      ref: codespaceRef,
    });
    logger.info('[LABS] codespace ready', { repo: repo.full_name, codespaceName: codespace.name });

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + LAB_TTL_MINUTES * 60 * 1000);
    const labId = uuidv4();
    const sessionId = uuidv4();
    const lab = {
      _id: labId,
      id: labId,
      user_id: userId,
      userId,
      session_id: sessionId,
      sessionId,
      lab_name: resolvedName.labName,
      codespace_display_name: codespace.display_name || resolvedName.displayName,
      displayName: codespace.display_name || resolvedName.displayName,
      repo_url: repoRef.normalizedUrl,
      repoUrl: repoRef.normalizedUrl,
      repo: repo.full_name,
      repo_name: repo.full_name,
      repoName: repo.name || repoRef.repo,
      repository: repo.full_name,
      repo_owner: repo.owner?.login || repoRef.owner,
      repoOwner: repo.owner?.login || repoRef.owner,
      repo_visibility: repo.visibility || (repo.private ? 'private' : 'public'),
      visibility: repo.visibility || (repo.private ? 'private' : 'public'),
      repo_private: Boolean(repo.private),
      repo_default_branch: repo.default_branch || null,
      repo_ref: codespaceRef || null,
      branch: codespaceRef || null,
      codespace_name: codespace.name,
      codespaceName: codespace.name,
      codespace_id: codespace.id || null,
      codespaceId: codespace.id || null,
      web_url: codespace.web_url,
      webUrl: codespace.web_url,
      status: 'active',
      active: true,
      created_at: createdAt.toISOString(),
      createdAt: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      github_user_id: githubSession.id,
      githubUserId: githubSession.id,
      github_username: githubSession.username,
      githubUsername: githubSession.username,
      connectionType: 'github_codespaces',
      connection_type: 'github_codespaces',
      lastOpenedAt: createdAt.toISOString(),
      last_opened_at: createdAt.toISOString(),
    };

    try {
      await firebaseService.createLab(lab);
      await firebaseService.createLabSession({
        _id: sessionId,
        id: sessionId,
        labId,
        lab_id: labId,
        userId,
        user_id: userId,
        startedAt: createdAt.toISOString(),
        started_at: createdAt.toISOString(),
        endedAt: null,
        ended_at: null,
        status: 'active',
      });
    } catch (firestoreErr) {
      logger.error('[LABS][FIRESTORE] Failed to persist lab metadata after Codespace creation', {
        labId,
        message: firestoreErr.message,
      });
      await destroyCodespaceForLab(githubSession.accessToken, lab).catch((cleanupErr) => {
        logger.warn('[LABS][GITHUB] Best-effort Codespace cleanup after Firestore failure failed:', cleanupErr.message);
      });
      await firebaseService.deleteLab(labId, {
        ...lab,
        status: 'deleted',
        active: false,
        deletedAt: new Date().toISOString(),
        firestore_error: firestoreErr.message,
      }).catch(() => {});

      const wrapped = new Error('Lab persistence failed after Codespace creation.');
      wrapped.statusCode = 503;
      wrapped.code = 'FIRESTORE_PERSISTENCE_FAILED';
      throw wrapped;
    }
    logger.info(`[LABS] Created lab ${lab._id} for ${userId}: ${lab.codespace_name}`);

    return apiSuccess(res, 201, {
      data: sanitizeLab(lab),
      web_url: lab.web_url,
      labId: lab._id,
      codespaceName: lab.codespace_name,
      webUrl: lab.web_url,
      expiresAt: lab.expires_at,
      message: 'Lab created.',
    });
  } catch (err) {
    logger.warn('[LABS] Failed to create lab:', err.message);
    return labError(res, err, 'Failed to create lab.');
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

