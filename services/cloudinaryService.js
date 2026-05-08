// ============================================
// CloudIQ Backend - Cloudinary Service
// ============================================
// Handles image uploads to Cloudinary.
// Images are stored in the 'tutorials' folder by default.

// Ensure env vars are loaded even if this module is required before server.js
require('dotenv').config();

const cloudinary = require('cloudinary').v2;

// ── Startup validation ───────────────────────
// Fail fast with a clear message instead of Cloudinary's cryptic "Must supply api_key"
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error(
    '[Cloudinary] ❌ Missing environment variables!\n' +
    `  CLOUDINARY_CLOUD_NAME : ${CLOUDINARY_CLOUD_NAME  || '⚠️  NOT SET'}\n` +
    `  CLOUDINARY_API_KEY    : ${CLOUDINARY_API_KEY     ? '✅ set' : '⚠️  NOT SET'}\n` +
    `  CLOUDINARY_API_SECRET : ${CLOUDINARY_API_SECRET  ? '✅ set' : '⚠️  NOT SET'}\n` +
    '  → Add these to your backend/.env and RESTART the server.'
  );
}

// Configure Cloudinary from env vars
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key:    CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

console.log('[Cloudinary] ✅ Configured for cloud:', CLOUDINARY_CLOUD_NAME || 'UNKNOWN');

/**
 * Upload a file buffer to Cloudinary.
 * @param {Buffer} buffer - The image file buffer from multer memoryStorage
 * @param {string} folder - Cloudinary folder name (e.g. 'tutorials')
 * @param {string} [publicId] - Optional custom public ID
 * @returns {Promise<{ secure_url: string, public_id: string }>}
 */
function uploadBuffer(buffer, folder = 'tutorials', publicId = undefined) {
  // Guard: reject immediately if Cloudinary isn't configured
  if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return Promise.reject(
      new Error(
        'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, ' +
        'CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in backend/.env, ' +
        'then restart the server.'
      )
    );
  }

  return new Promise((resolve, reject) => {
    const opts = {
      folder,
      resource_type: 'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    };
    if (publicId) opts.public_id = publicId;

    const stream = cloudinary.uploader.upload_stream(opts, (err, result) => {
      if (err) return reject(err);
      resolve({ secure_url: result.secure_url, public_id: result.public_id });
    });

    stream.end(buffer);
  });
}

/**
 * Upload a video buffer to Cloudinary.
 * @param {Buffer} buffer
 * @param {string} folder
 * @param {string} [publicId]
 * @returns {Promise<{ secure_url: string, public_id: string }>}
 */
function uploadVideoBuffer(buffer, folder = 'videos', publicId = undefined) {
  if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return Promise.reject(
      new Error(
        'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, ' +
        'CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in backend/.env, ' +
        'then restart the server.'
      )
    );
  }

  return new Promise((resolve, reject) => {
    const opts = {
      folder,
      resource_type: 'video',
      allowed_formats: ['mp4', 'webm', 'mov', 'm4v'],
    };
    if (publicId) opts.public_id = publicId;

    const stream = cloudinary.uploader.upload_stream(opts, (err, result) => {
      if (err) return reject(err);
      resolve({ secure_url: result.secure_url, public_id: result.public_id });
    });

    stream.end(buffer);
  });
}

/**
 * Upload a raw (attachment) buffer to Cloudinary.
 * @param {Buffer} buffer
 * @param {string} folder
 * @param {string} [publicId]
 * @param {string} [filename]
 * @returns {Promise<{ secure_url: string, public_id: string }>}
 */
function uploadRawBuffer(buffer, folder = 'attachments', publicId = undefined, filename = undefined) {
  if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return Promise.reject(
      new Error(
        'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, ' +
        'CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in backend/.env, ' +
        'then restart the server.'
      )
    );
  }

  return new Promise((resolve, reject) => {
    const opts = {
      folder,
      resource_type: 'raw',
      use_filename: Boolean(filename),
      unique_filename: true,
    };
    if (publicId) opts.public_id = publicId;
    if (filename) opts.filename_override = filename;

    const stream = cloudinary.uploader.upload_stream(opts, (err, result) => {
      if (err) return reject(err);
      resolve({ secure_url: result.secure_url, public_id: result.public_id });
    });

    stream.end(buffer);
  });
}

/**
 * Delete an image from Cloudinary by its public_id.
 * @param {string} publicId
 * @returns {Promise<void>}
 */
async function deleteImage(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.error('[Cloudinary] Failed to delete image:', publicId, err.message);
  }
}

/**
 * Delete media from Cloudinary by public_id and resource type.
 * @param {string} publicId
 * @param {'image'|'video'} resourceType
 * @returns {Promise<void>}
 */
async function deleteMedia(publicId, resourceType = 'image') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('[Cloudinary] Failed to delete media:', publicId, err.message);
  }
}

module.exports = { uploadBuffer, uploadVideoBuffer, uploadRawBuffer, deleteImage, deleteMedia };
