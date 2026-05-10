const cron = require('node-cron');
const {
  fetchCodespace,
  stopCodespace,
  deleteCodespace,
} = require('./githubCodespacesService');
const firebaseService = require('./firebaseService');
const logger = require('../utils/logger');

const CLEANUP_INTERVAL = '*/5 * * * *';

let cleanupTask = null;
let cleanupRunning = false;

function errorDetails(err) {
  const status = err.status || err.statusCode || err.code || 'no-status';
  const message = err.message || 'Lab cleanup request failed';
  return `${status}: ${message}`;
}

async function findExpiredActiveLabs(nowIso) {
  return firebaseService.getExpiredActiveLabs(nowIso, 100);
}

function buildReleasedLabDocument(lab, status, details = {}) {
  const now = new Date().toISOString();
  return {
    ...lab,
    status,
    active: false,
    codespace_name: null,
    web_url: null,
    session_data: null,
    codespace_session: null,
    deleted_at: status === 'deleted' ? now : lab.deleted_at,
    deletedAt: status === 'deleted' ? now : lab.deletedAt,
    expired_at: status === 'expired' ? now : lab.expired_at,
    expiredAt: status === 'expired' ? now : lab.expiredAt,
    cleanup_error: details.cleanup_error || undefined,
    github_cleanup_warning: details.github_cleanup_warning || undefined,
    updated_at: now,
    updatedAt: now,
  };
}

async function softDeleteLabDocument(lab, status, details = {}) {
  const labId = lab._id || lab.id;
  const updated = buildReleasedLabDocument(lab, status, details);
  const saved = status === 'deleted'
    ? await firebaseService.deleteLab(labId, updated)
    : await firebaseService.updateLab(labId, updated);

  await firebaseService.updateLabSession(lab.sessionId || lab.session_id || labId, {
    labId,
    userId: lab.userId || lab.user_id,
    status,
    endedAt: new Date().toISOString(),
  }).catch((err) => {
    logger.warn('[LABS][FIRESTORE] Failed to close expired lab session:', err.message);
  });

  logger.debug('[LABS][FIRESTORE] lab released');
  logger.debug('[LABS] active lab released');
  return saved;
}

async function removeLabDocument(lab, status = 'expired', details = {}) {
  const document = await softDeleteLabDocument(lab, status, details);
  return { removed: false, document };
}

async function destroyExpiredCodespace(lab, accessToken) {
  const codespaceName = lab.codespaceName || lab.codespace_name;
  if (!codespaceName) {
    logger.debug(`[LABS][CLEANUP] Lab ${lab._id} has no codespace name; treating it as already removed.`);
    return { warning: undefined };
  }

  const codespaceResult = await fetchCodespace(accessToken, codespaceName, { recoverable: true });
  if (codespaceResult.alreadyRemoved) {
    logger.debug(`[LABS][CLEANUP] Codespace already removed for expired lab ${lab._id}.`);
    return { warning: codespaceResult.message };
  }
  if (codespaceResult.recoverable) {
    logger.warn(`[LABS][CLEANUP] Skipping remote cleanup for expired lab ${lab._id}: ${codespaceResult.message}`);
    return { warning: codespaceResult.message };
  }

  const state = codespaceResult.data?.state;
  if (codespaceResult.ok && !['Shutdown', 'ShuttingDown'].includes(state)) {
    logger.info(`[LABS][CLEANUP] Stopping expired codespace ${codespaceName}.`);
    const stopResult = await stopCodespace(accessToken, codespaceName, { recoverable: true });
    if (stopResult.alreadyRemoved) {
      logger.debug(`[LABS][CLEANUP] Codespace already removed for expired lab ${lab._id}.`);
      return { warning: stopResult.message };
    }
    if (stopResult.recoverable) {
      logger.warn(`[LABS][CLEANUP] Recoverable stop failure for ${codespaceName}: ${stopResult.message}`);
    }
  }

  logger.info(`[LABS][CLEANUP] Deleting expired codespace ${codespaceName}.`);
  const deleteResult = await deleteCodespace(accessToken, codespaceName, { recoverable: true });
  if (deleteResult.ok) {
    logger.info(`[LABS][CLEANUP] Deleted expired codespace ${codespaceName}.`);
  } else if (deleteResult.alreadyRemoved) {
    logger.debug(`[LABS][CLEANUP] Codespace already removed for expired lab ${lab._id}.`);
  } else if (deleteResult.recoverable) {
    logger.warn(`[LABS][CLEANUP] Recoverable delete failure for ${codespaceName}: ${deleteResult.message}`);
  }

  return {
    warning: deleteResult.recoverable ? deleteResult.message : codespaceResult.message,
  };
}

async function cleanupExpiredLabs() {
  if (cleanupRunning) {
    logger.debug('[LABS][CLEANUP] Previous cleanup is still running; skipping this tick.');
    return;
  }

  cleanupRunning = true;
  const nowIso = new Date().toISOString();
  logger.debug(`[LABS][CLEANUP] Checking for expired labs at ${nowIso}`);

  try {
    const labs = await findExpiredActiveLabs(nowIso);
    if (!labs.length) {
      logger.debug('[LABS][CLEANUP] No expired active labs found.');
      return;
    }

    logger.info(`[LABS][CLEANUP] Found ${labs.length} expired lab(s).`);
    for (const lab of labs) {
      try {
        const accessToken = null;
        const cleanupResult = await destroyExpiredCodespace(lab, accessToken);
        await removeLabDocument(lab, 'expired', {
          github_cleanup_warning: cleanupResult.warning,
        });
        logger.info('[LABS] cleanup completed', { labId: lab._id });
        logger.info('[LABS][CLEANUP] cleanup completed successfully');
      } catch (err) {
        logger.error(`[LABS][CLEANUP] Failed to cleanup lab ${lab._id}:`, errorDetails(err));
        try {
          await softDeleteLabDocument(lab, 'cleanup_failed', { cleanup_error: errorDetails(err) });
          logger.debug(`[LABS][CLEANUP] Released active lock for failed cleanup lab ${lab._id}.`);
        } catch (markErr) {
          logger.error(`[LABS][CLEANUP] Failed to release active lock for lab ${lab._id}:`, errorDetails(markErr));
        }
      }
    }
  } catch (err) {
    logger.error('[LABS][CLEANUP] Cleanup tick failed:', errorDetails(err));
  } finally {
    cleanupRunning = false;
  }
}

function startLabCleanupService() {
  if (cleanupTask) return cleanupTask;

  cleanupTask = cron.schedule(CLEANUP_INTERVAL, cleanupExpiredLabs, {
    scheduled: true,
    timezone: 'UTC',
  });

  logger.info(`[LABS][CLEANUP] Scheduled cleanup every 5 minutes (${CLEANUP_INTERVAL}).`);
  cleanupExpiredLabs().catch((err) => {
    logger.error('[LABS][CLEANUP] Initial cleanup failed:', err.message);
  });

  return cleanupTask;
}

async function stopLabCleanupService() {
  if (cleanupTask) {
    cleanupTask.stop();
    cleanupTask = null;
    logger.info('[LABS][CLEANUP] Cleanup scheduler stopped.');
  }

  if (cleanupRunning) {
    logger.debug('[LABS][CLEANUP] Waiting for in-flight cleanup to finish.');
  }
}

module.exports = {
  startLabCleanupService,
  stopLabCleanupService,
  cleanupExpiredLabs,
};

