const { v4: uuidv4 } = require('uuid');
const cloudant = require('./cloudantClient');
const { uploadBuffer, uploadVideoBuffer, uploadRawBuffer, deleteMedia } = require('./cloudinaryService');

async function recordUploadMetadata({
  ownerId,
  contextType,
  contextId,
  resourceType,
  url,
  publicId,
  mimeType,
  sizeBytes,
}) {
  if (!ownerId || !url || !publicId) return null;

  const doc = {
    _id: uuidv4(),
    owner_id: ownerId,
    context_type: contextType || null,
    context_id: contextId || null,
    resource_type: resourceType || 'image',
    url,
    public_id: publicId,
    mime_type: mimeType || null,
    size_bytes: sizeBytes || null,
    created_at: new Date().toISOString(),
  };

  try {
    await cloudant.postDocument({ db: 'upload_metadata', document: doc });
    return doc;
  } catch (err) {
    console.warn('[MEDIA] Upload metadata write failed:', err.message);
    return null;
  }
}

async function recordTutorialMedia({ tutorialId, url, publicId, resourceType }) {
  if (!tutorialId || !url || !publicId) return null;

  const doc = {
    _id: uuidv4(),
    tutorial_id: tutorialId,
    url,
    public_id: publicId,
    resource_type: resourceType || 'image',
    created_at: new Date().toISOString(),
  };

  try {
    await cloudant.postDocument({ db: 'tutorial_media', document: doc });
    return doc;
  } catch (err) {
    console.warn('[MEDIA] Tutorial media write failed:', err.message);
    return null;
  }
}

async function uploadImage({ buffer, folder, ownerId, contextType, contextId, mimeType, sizeBytes }) {
  const uploaded = await uploadBuffer(buffer, folder);
  await recordUploadMetadata({
    ownerId,
    contextType,
    contextId,
    resourceType: 'image',
    url: uploaded.secure_url,
    publicId: uploaded.public_id,
    mimeType,
    sizeBytes,
  });
  return uploaded;
}

async function uploadVideo({ buffer, folder, ownerId, contextType, contextId, mimeType, sizeBytes }) {
  const uploaded = await uploadVideoBuffer(buffer, folder);
  await recordUploadMetadata({
    ownerId,
    contextType,
    contextId,
    resourceType: 'video',
    url: uploaded.secure_url,
    publicId: uploaded.public_id,
    mimeType,
    sizeBytes,
  });
  return uploaded;
}

async function uploadRaw({ buffer, folder, ownerId, contextType, contextId, mimeType, sizeBytes, filename }) {
  const uploaded = await uploadRawBuffer(buffer, folder, undefined, filename);
  await recordUploadMetadata({
    ownerId,
    contextType,
    contextId,
    resourceType: 'raw',
    url: uploaded.secure_url,
    publicId: uploaded.public_id,
    mimeType,
    sizeBytes,
  });
  return uploaded;
}

async function deleteUploadedMedia(publicId, resourceType) {
  if (!publicId) return;
  await deleteMedia(publicId, resourceType || 'image');
}

module.exports = {
  uploadImage,
  uploadVideo,
  uploadRaw,
  deleteUploadedMedia,
  recordTutorialMedia,
  recordUploadMetadata,
};
