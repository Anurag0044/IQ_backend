const { v4: uuidv4 } = require('uuid');
const db = require('./firestoreClient');

function buildDedupeFilters(notification) {
  const filters = [
    ['type', '==', notification.type],
    ['user_id', '==', notification.user_id],
    ['from_user_id', '==', notification.from_user_id],
    ['read', '==', false]
  ];

  if (notification.post_id) filters.push(['post_id', '==', notification.post_id]);
  if (notification.comment_id) filters.push(['comment_id', '==', notification.comment_id]);
  if (notification.target_type) filters.push(['target_type', '==', notification.target_type]);
  if (notification.target_id) filters.push(['target_id', '==', notification.target_id]);

  return filters;
}

async function resolveSenderInfo(senderId, fallbackName, fallbackAvatar) {
  let senderName = fallbackName || 'User';
  let senderAvatar = fallbackAvatar || null;

  if (!senderId) return { senderName, senderAvatar };

  try {
    const profileDoc = await db.getDoc('users', senderId);
    if (profileDoc.username) senderName = profileDoc.username;
    if (profileDoc.profile_image_url) senderAvatar = profileDoc.profile_image_url;
  } catch (err) {
    // Fall back to provided values if not found
  }

  return { senderName, senderAvatar };
}

async function createNotification({
  io,
  userSockets,
  recipientId,
  senderId,
  senderName,
  senderAvatar,
  type,
  message,
  postId,
  commentId,
  targetType,
  targetId,
}) {
  if (!recipientId || !senderId || !type || !message) {
    return { created: false, skipped: true, reason: 'missing_fields' };
  }

  if (recipientId === senderId) {
    return { created: false, skipped: true, reason: 'self_notification' };
  }

  const notification = {
    user_id: recipientId,
    from_user_id: senderId,
    sender_name: senderName || 'User',
    sender_avatar: senderAvatar || null,
    type,
    post_id: postId || null,
    comment_id: commentId || null,
    target_type: targetType || null,
    target_id: targetId || null,
    message,
    read: false,
    created_at: new Date().toISOString(),
  };

  const filters = buildDedupeFilters(notification);
  const existing = await db.queryDocs('notifications', filters, null, 'asc', 1);

  if (existing.length > 0) {
    return { created: false, notification: existing[0] };
  }

  const id = uuidv4();
  await db.setDoc('notifications', id, notification);
  notification._id = id;

  if (io && userSockets) {
    const targetSocketId = userSockets.get(recipientId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('new_notification', notification);
    }
  }

  return { created: true, notification };
}

module.exports = {
  resolveSenderInfo,
  createNotification,
};
