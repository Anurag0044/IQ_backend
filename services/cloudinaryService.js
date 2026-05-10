// ============================================
// CloudIQ Backend - Cloudinary Service
// ============================================
// Handles Cloudinary uploads from in-memory buffers only.

require('dotenv').config();

const cloudinary = require('cloudinary').v2;

const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

function isCloudinaryConfigured() {
  return Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}

function cloudinaryUnavailableError() {
  return new Error(
    'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, ' +
    'CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in backend/.env, then restart the server.'
  );
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

if (isCloudinaryConfigured()) {
  console.log('[CLOUDINARY] initialized successfully', {
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKeyConfigured: true,
    apiSecretConfigured: true,
  });
} else {
  console.error('[CLOUDINARY] missing environment variables', {
    cloudNameConfigured: Boolean(CLOUDINARY_CLOUD_NAME),
    apiKeyConfigured: Boolean(CLOUDINARY_API_KEY),
    apiSecretConfigured: Boolean(CLOUDINARY_API_SECRET),
  });
}

function sanitizeFolderSegment(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100) || 'unknown';
}

function sanitizeOriginalFilename(value) {
  return String(value || 'file')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120) || 'file';
}

function getDiscussionResourceType(mimeType) {
  if (String(mimeType || '').startsWith('image/')) return 'image';
  if (String(mimeType || '').startsWith('video/')) return 'video';
  return 'raw';
}

function uploadToCloudinary(buffer, folder, resourceType = 'auto', options = {}) {
  if (!isCloudinaryConfigured()) {
    return Promise.reject(cloudinaryUnavailableError());
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return Promise.reject(new Error('Invalid Cloudinary upload buffer'));
  }

  const fileName = options.fileName ? sanitizeOriginalFilename(options.fileName) : null;
  console.log('[CLOUDINARY] buffer type valid', {
    isBuffer: Buffer.isBuffer(buffer),
    bytes: buffer.length,
    mimeType: options.mimeType || null,
    fileName,
  });
  console.log('[CLOUDINARY] upload stream starting', {
    folder,
    resourceType,
    bytes: buffer.length,
    mimeType: options.mimeType || null,
    fileName,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;

      if (error) {
        console.error('[CLOUDINARY] upload failed', {
          message: error.message,
          name: error.name,
          http_code: error.http_code,
          stack: error.stack,
        });
        reject(error);
        return;
      }

      console.log('[CLOUDINARY] upload completed', {
        publicId: result?.public_id,
        resourceType: result?.resource_type,
        bytes: result?.bytes,
      });
      console.log('[CLOUDINARY] secure URL generated', {
        publicId: result?.public_id,
        secureUrl: Boolean(result?.secure_url),
      });
      resolve(result);
    };

    try {
      const uploadOptions = {
        folder,
        resource_type: resourceType,
      };

      if (fileName) {
        uploadOptions.use_filename = true;
        uploadOptions.unique_filename = true;
        uploadOptions.filename_override = fileName;
      }
      if (options.context) uploadOptions.context = options.context;

      const stream = cloudinary.uploader.upload_stream(uploadOptions, finish);
      stream.on('error', (error) => finish(error));
      stream.end(buffer);
    } catch (error) {
      finish(error);
    }
  });
}

async function uploadBuffer(buffer, folder = 'tutorials', publicId = undefined) {
  const result = await uploadToCloudinary(buffer, folder, 'image', { fileName: publicId || null });
  return { secure_url: result.secure_url, public_id: result.public_id };
}

async function uploadVideoBuffer(buffer, folder = 'videos', publicId = undefined) {
  const result = await uploadToCloudinary(buffer, folder, 'video', { fileName: publicId || null });
  return { secure_url: result.secure_url, public_id: result.public_id };
}

async function uploadRawBuffer(buffer, folder = 'attachments', publicId = undefined, filename = undefined) {
  const result = await uploadToCloudinary(buffer, folder, 'raw', { fileName: filename || publicId || null });
  return { secure_url: result.secure_url, public_id: result.public_id };
}

async function uploadDiscussionMedia(file, communityId, channelId) {
  if (!communityId || !channelId || !Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) {
    throw new Error('Invalid discussion media upload');
  }

  const folder = [
    'cloudiq',
    'discussions',
    sanitizeFolderSegment(communityId),
    sanitizeFolderSegment(channelId),
  ].join('/');
  const fileName = sanitizeOriginalFilename(file.originalname);
  const expectedResourceType = getDiscussionResourceType(file.mimetype);

  console.log('[CLOUDINARY] upload stream started', {
    communityId,
    channelId,
    folder,
    fileName,
    mimeType: file.mimetype || null,
    size: file.size || file.buffer.length,
    resourceType: 'auto',
  });

  const result = await uploadToCloudinary(file.buffer, folder, 'auto', {
    fileName,
    mimeType: file.mimetype || null,
    context: {
      original_filename: fileName,
      mime_type: file.mimetype || '',
      community_id: String(communityId),
      channel_id: String(channelId),
    },
  });

  return {
    secure_url: result.secure_url,
    public_id: result.public_id,
    resource_type: result.resource_type || expectedResourceType,
    bytes: result.bytes || file.size || file.buffer.length,
    format: result.format || null,
  };
}

async function deleteImage(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('[Cloudinary] Failed to delete image:', publicId, error.message);
  }
}

async function deleteMedia(publicId, resourceType = 'image') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (error) {
    console.error('[Cloudinary] Failed to delete media:', publicId, error.message);
  }
}

module.exports = {
  uploadBuffer,
  uploadVideoBuffer,
  uploadRawBuffer,
  uploadDiscussionMedia,
  deleteImage,
  deleteMedia,
};
