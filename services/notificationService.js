const { v4: uuidv4 } = require('uuid');

function buildDedupeSelector(notification) {
  const selector = {
    type: notification.type,
    user_id: notification.user_id,
    from_user_id: notification.from_user_id,
    read: false,
  };

  if (notification.post_id) selector.post_id = notification.post_id;
  if (notification.comment_id) selector.comment_id = notification.comment_id;
  if (notification.target_type) selector.target_type = notification.target_type;
  if (notification.target_id) selector.target_id = notification.target_id;

  return selector;
}

async function resolveSenderInfo(cloudant, senderId, fallbackName, fallbackAvatar) {
  let senderName = fallbackName || 'User';
  let senderAvatar = fallbackAvatar || null;

  if (!senderId) return { senderName, senderAvatar };

  try {
    const profileDoc = (await cloudant.getDocument({ db: 'users', docId: senderId })).result;
    if (profileDoc.username) senderName = profileDoc.username;
    if (profileDoc.profile_image_url) senderAvatar = profileDoc.profile_image_url;
  } catch (err) {
    // Fall back to App ID values
  }

  return { senderName, senderAvatar };
}

async function createNotification({
  cloudant,
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
  if (!cloudant || !recipientId || !senderId || !type || !message) {
    return { created: false, skipped: true, reason: 'missing_fields' };
  }

  if (recipientId === senderId) {
    return { created: false, skipped: true, reason: 'self_notification' };
  }

  const notification = {
    _id: uuidv4(),
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

  const selector = buildDedupeSelector(notification);
  const existing = await cloudant.postFind({
    db: 'notifications',
    selector,
    limit: 1,
  });

  if (existing.result.docs.length > 0) {
    return { created: false, notification: existing.result.docs[0] };
  }

  await cloudant.postDocument({
    db: 'notifications',
    document: notification,
  });

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
