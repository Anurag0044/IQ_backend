const cron = require('node-cron');
const cloudant = require('./cloudantClient');
const {
  fetchCodespace,
  stopCodespace,
  deleteCodespace,
  decryptAccessToken,
} = require('./githubCodespacesService');

const DB_NAME = 'lab_sessions';
const CLEANUP_INTERVAL = '*/5 * * * *';

let cleanupTask = null;
let cleanupRunning = false;

function cloudantErrorDetails(err) {
  const status = err.status || err.statusCode || err.code || 'no-status';
  const message = err.message || 'Cloudant request failed';
  return `${status}: ${message}`;
}

async function verifyCloudantCleanupAuth() {
  await cloudant.getDatabaseInformation({ db: DB_NAME });
  console.log('[LABS][CLOUDANT] cleanup auth verified');
}

async function findExpiredActiveLabs(nowIso) {
  const response = await cloudant.postFind({
    db: DB_NAME,
    selector: {
      status: 'active',
      expires_at: { $lte: nowIso },
    },
    limit: 100,
  });
  return response.result.docs || [];
}

async function fetchLabDocument(labId) {
  const response = await cloudant.getDocument({ db: DB_NAME, docId: labId });
  return response.result;
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
    github_access_token_encrypted: null,
    deleted_at: status === 'deleted' ? now : lab.deleted_at,
    expired_at: status === 'expired' ? now : lab.expired_at,
    cleanup_error: details.cleanup_error || undefined,
    github_cleanup_warning: details.github_cleanup_warning || undefined,
    updated_at: now,
  };
}

async function softDeleteLabDocument(lab, status, details = {}) {
  const freshLab = await fetchLabDocument(lab._id).catch((err) => {
    if (err.status === 404 || err.statusCode === 404) return null;
    throw err;
  });

  if (!freshLab) {
    console.log(`[LABS][CLOUDANT] lab document already removed: ${lab._id}`);
    return null;
  }

  const updated = buildReleasedLabDocument(freshLab, status, details);
  await cloudant.putDocument({
    db: DB_NAME,
    docId: freshLab._id,
    document: updated,
  });

  console.log('[LABS][CLOUDANT] soft delete fallback used');
  console.log('[LABS] active lab released');
  return updated;
}

async function removeLabDocument(lab, status = 'expired', details = {}) {
  console.log('[LABS][CLOUDANT] removing lab document');
  console.log('[LABS][CLOUDANT] deleting lab document');

  let lastDeleteError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const freshLab = await fetchLabDocument(lab._id);
      await cloudant.deleteDocument({
        db: DB_NAME,
        docId: freshLab._id,
        rev: freshLab._rev,
      });
      console.log('[LABS][CLOUDANT] lab document removed');
      console.log('[LABS] active lab released');
      return { removed: true, document: null };
    } catch (err) {
      if (err.status === 404 || err.statusCode === 404) {
        console.log(`[LABS][CLOUDANT] lab document already removed: ${lab._id}`);
        console.log('[LABS] active lab released');
        return { removed: true, document: null };
      }

      lastDeleteError = err;
      console.warn(`[LABS][CLOUDANT] hard delete attempt ${attempt} failed for ${lab._id}: ${cloudantErrorDetails(err)}`);
    }
  }

  try {
    const fallback = await softDeleteLabDocument(lab, status, {
      ...details,
      cleanup_error: details.cleanup_error || cloudantErrorDetails(lastDeleteError),
    });
    return { removed: false, document: fallback };
  } catch (fallbackErr) {
    console.error(`[LABS][CLOUDANT] soft delete fallback failed for ${lab._id}: ${cloudantErrorDetails(fallbackErr)}`);
    throw fallbackErr;
  }
}

function decryptLabCleanupToken(lab) {
  try {
    return decryptAccessToken(lab.github_access_token_encrypted);
  } catch (err) {
    console.warn(`[LABS][CLEANUP] Could not decrypt GitHub token for lab ${lab._id}: ${err.message}`);
    return null;
  }
}

async function destroyExpiredCodespace(lab, accessToken) {
  const codespaceName = lab.codespace_name;
  if (!codespaceName) {
    console.log(`[LABS][CLEANUP] Lab ${lab._id} has no codespace name; treating it as already removed.`);
    return { warning: undefined };
  }

  const codespaceResult = await fetchCodespace(accessToken, codespaceName, { recoverable: true });
  if (codespaceResult.alreadyRemoved) {
    console.log(`[LABS][CLEANUP] Codespace already removed for expired lab ${lab._id}.`);
    return { warning: codespaceResult.message };
  }

  const state = codespaceResult.data?.state;
  if (codespaceResult.ok && !['Shutdown', 'ShuttingDown'].includes(state)) {
    console.log(`[LABS][CLEANUP] Stopping expired codespace ${codespaceName}.`);
    const stopResult = await stopCodespace(accessToken, codespaceName, { recoverable: true });
    if (stopResult.alreadyRemoved) {
      console.log(`[LABS][CLEANUP] Codespace already removed for expired lab ${lab._id}.`);
      return { warning: stopResult.message };
    }
    if (stopResult.recoverable) {
      console.warn(`[LABS][CLEANUP] Recoverable stop failure for ${codespaceName}: ${stopResult.message}`);
    }
  }

  console.log(`[LABS][CLEANUP] Deleting expired codespace ${codespaceName}.`);
  const deleteResult = await deleteCodespace(accessToken, codespaceName, { recoverable: true });
  if (deleteResult.ok) {
    console.log(`[LABS][CLEANUP] Deleted expired codespace ${codespaceName}.`);
  } else if (deleteResult.alreadyRemoved) {
    console.log(`[LABS][CLEANUP] Codespace already removed for expired lab ${lab._id}.`);
  } else if (deleteResult.recoverable) {
    console.warn(`[LABS][CLEANUP] Recoverable delete failure for ${codespaceName}: ${deleteResult.message}`);
  }

  return {
    warning: deleteResult.recoverable ? deleteResult.message : codespaceResult.message,
  };
}

async function cleanupExpiredLabs() {
  if (cleanupRunning) {
    console.log('[LABS][CLEANUP] Previous cleanup is still running; skipping this tick.');
    return;
  }

  cleanupRunning = true;
  const nowIso = new Date().toISOString();
  console.log(`[LABS][CLEANUP] Checking for expired labs at ${nowIso}`);

  try {
    await verifyCloudantCleanupAuth();
    const labs = await findExpiredActiveLabs(nowIso);
    if (!labs.length) {
      console.log('[LABS][CLEANUP] No expired active labs found.');
      return;
    }

    console.log(`[LABS][CLEANUP] Found ${labs.length} expired lab(s).`);
    for (const lab of labs) {
      try {
        const accessToken = decryptLabCleanupToken(lab);
        const cleanupResult = await destroyExpiredCodespace(lab, accessToken);
        await removeLabDocument(lab, 'expired', {
          github_cleanup_warning: cleanupResult.warning,
        });
        console.log('[LABS][CLEANUP] cleanup completed successfully');
      } catch (err) {
        console.error(`[LABS][CLEANUP] Failed to cleanup lab ${lab._id}:`, cloudantErrorDetails(err));
        try {
          await softDeleteLabDocument(lab, 'cleanup_failed', { cleanup_error: cloudantErrorDetails(err) });
          console.log(`[LABS][CLEANUP] Released active lock for failed cleanup lab ${lab._id}.`);
        } catch (markErr) {
          console.error(`[LABS][CLEANUP] Failed to release active lock for lab ${lab._id}:`, cloudantErrorDetails(markErr));
        }
      }
    }
  } catch (err) {
    console.error('[LABS][CLEANUP] Cleanup tick failed:', cloudantErrorDetails(err));
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

  console.log(`[LABS][CLEANUP] Scheduled cleanup every 5 minutes (${CLEANUP_INTERVAL}).`);
  cleanupExpiredLabs().catch((err) => {
    console.error('[LABS][CLEANUP] Initial cleanup failed:', err.message);
  });

  return cleanupTask;
}

async function stopLabCleanupService() {
  if (cleanupTask) {
    cleanupTask.stop();
    cleanupTask = null;
    console.log('[LABS][CLEANUP] Cleanup scheduler stopped.');
  }

  if (cleanupRunning) {
    console.log('[LABS][CLEANUP] Waiting for in-flight cleanup to finish.');
  }
}

module.exports = {
  startLabCleanupService,
  stopLabCleanupService,
  cleanupExpiredLabs,
};
