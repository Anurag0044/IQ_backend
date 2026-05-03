const cloudant = require('../services/cloudantClient');

const DB_NAME = 'community_data';
const DOC_ID = 'all_users_data';

// In-memory cache for synchronous operations
let inMemoryDB = { users: [] };
let _rev = undefined;

async function initDB() {
  try {
    await cloudant.getDatabaseInformation({ db: DB_NAME });
  } catch (err) {
    if (err.status === 404) {
      try {
        await cloudant.putDatabase({ db: DB_NAME });
      } catch (e) {
        console.error('[DB] Failed to create database:', e);
      }
    }
  }

  try {
    const doc = await cloudant.getDocument({ db: DB_NAME, docId: DOC_ID });
    inMemoryDB = doc.result;
    _rev = doc.result._rev;
    if (!inMemoryDB.users) inMemoryDB.users = [];
  } catch (err) {
    if (err.status === 404) {
      const initialDoc = { _id: DOC_ID, users: [] };
      try {
        const response = await cloudant.postDocument({ db: DB_NAME, document: initialDoc });
        inMemoryDB = initialDoc;
        _rev = response.result.rev;
      } catch (e) {
        console.error('[DB] Failed to create initial doc:', e);
      }
    }
  }
}

// Initialize on startup
initDB();

function readDB() {
  return inMemoryDB;
}

function writeDB(data) {
  inMemoryDB = data;
  inMemoryDB._id = DOC_ID;
  if (_rev) inMemoryDB._rev = _rev;

  // Async save to Cloudant
  cloudant.postDocument({ db: DB_NAME, document: inMemoryDB })
    .then(response => {
      if (response.result.ok) {
        _rev = response.result.rev;
      }
    })
    .catch(err => {
      // 409 means conflict (someone else updated it). We just ignore or fetch latest in a real app.
      if (err.status !== 409) {
        console.error('[DB] Error writing to Cloudant:', err.message);
      }
    });
}

/**
 * Ensures a user exists in the database.
 * If not, creates them. If they are the super admin, ensures they have admin role.
 */
function syncUser(userData) {
  const db = readDB();
  const superAdminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(e => e);
  
  const userEmail = (userData.email || (userData.emails && userData.emails[0]?.value) || '').toLowerCase();
  
  if (!userEmail) return null;

  if (!db.users) db.users = [];
  let user = db.users.find(u => u.email === userEmail);
  const isSuperAdmin = superAdminEmails.includes(userEmail);

  if (!user) {
    user = {
      email: userEmail,
      name: userData.name || userData.given_name || 'Unknown',
      picture: userData.picture || null,
      role: isSuperAdmin ? 'admin' : 'user', // Super admin defaults to admin
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
    db.users.push(user);
    writeDB(db);
  } else {
    // Update last login and potentially promote super admin if they were demoted somehow
    let updated = false;
    if (isSuperAdmin && user.role !== 'admin') {
      user.role = 'admin';
      updated = true;
    }
    if (user.name !== (userData.name || userData.given_name)) {
      user.name = userData.name || userData.given_name;
      updated = true;
    }
    user.lastLogin = new Date().toISOString();
    writeDB(db);
  }
  
  return user;
}

function getUserRole(email) {
  if (!email) return 'user';
  email = email.toLowerCase();
  
  const superAdminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(e => e);
  if (superAdminEmails.includes(email)) return 'admin';

  const db = readDB();
  if (!db.users) return 'user';
  const user = db.users.find(u => u.email === email);
  return user ? user.role : 'user';
}

function getAllUsers() {
  const db = readDB();
  return db.users || [];
}

function updateUserRole(email, newRole) {
  const db = readDB();
  email = email.toLowerCase();
  
  const superAdminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(e => e);
  if (superAdminEmails.includes(email) && newRole !== 'admin') {
    throw new Error('Cannot demote super admin');
  }

  if (!db.users) db.users = [];
  const user = db.users.find(u => u.email === email);
  if (!user) {
    // Create skeleton user if they haven't logged in yet but admin is adding them
    db.users.push({
      email,
      name: 'Pending User',
      picture: null,
      role: newRole,
      createdAt: new Date().toISOString(),
      lastLogin: null
    });
  } else {
    user.role = newRole;
  }
  writeDB(db);
  return true;
}

function deleteUser(email) {
  const db = readDB();
  email = email.toLowerCase();
  
  const superAdminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(e => e);
  if (superAdminEmails.includes(email)) {
    throw new Error('Cannot delete super admin');
  }

  if (db.users) {
    db.users = db.users.filter(u => u.email !== email);
    writeDB(db);
  }
  return true;
}

function addNotification(toEmail, notification) {
  const db = readDB();
  if (!db.notifications) db.notifications = [];
  
  db.notifications.push({
    id: require('crypto').randomUUID(),
    toEmail: toEmail.toLowerCase(),
    ...notification,
    createdAt: new Date().toISOString()
  });
  writeDB(db);
}

function getNotifications(email) {
  const db = readDB();
  if (!db.notifications) return [];
  return db.notifications
    .filter(n => n.toEmail === email.toLowerCase())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = {
  syncUser,
  getUserRole,
  getAllUsers,
  updateUserRole,
  deleteUser,
  addNotification,
  getNotifications
};
