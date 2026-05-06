const express = require('express');
const multer = require('multer');
const { IamAuthenticator } = require('ibm-watson/auth');
const SpeechToTextV1 = require('ibm-watson/speech-to-text/v1');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

let speechToText;
try {
  speechToText = new SpeechToTextV1({
    authenticator: new IamAuthenticator({
      apikey: process.env.WATSON_STT_API_KEY,
    }),
    serviceUrl: process.env.WATSON_STT_URL,
  });
} catch (error) {
  console.warn('[VOICE] Watson Speech to Text is not fully configured:', error.message);
}

/**
 * POST /api/voice/transcribe
 * Accepts an audio file and transcribes it using IBM Watson
 */
router.post('/transcribe', ensureAuthenticated, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No audio file uploaded' });
    }

    if (!speechToText) {
      return res.status(500).json({ success: false, error: 'Watson STT is not configured on the server' });
    }

    // Identify audio content type (e.g., audio/webm from browser MediaRecorder)
    // Watson supports audio/webm, audio/wav, audio/mp3, audio/flac, etc.
    const contentType = req.file.mimetype || 'audio/webm';

    const recognizeParams = {
      audio: req.file.buffer,
      contentType: contentType,
      model: 'en-US_BroadbandModel', // Default model
    };

    const response = await speechToText.recognize(recognizeParams);
    const results = response.result.results;

    if (results && results.length > 0) {
      const transcript = results.map(r => r.alternatives[0].transcript).join(' ');
      res.json({ success: true, transcript: transcript.trim() });
    } else {
      res.json({ success: true, transcript: '' });
    }
  } catch (error) {
    console.error('[VOICE] Transcription error:', error);
    res.status(500).json({ success: false, error: 'Failed to transcribe audio' });
  }
});

module.exports = router;
