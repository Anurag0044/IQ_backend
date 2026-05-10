const express = require('express');
const axios = require('axios');
const { ensureAuthenticated } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

const NVIDIA_API_URL = process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_API_KEY = process.env.ORION_API_KEY || process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || '';
const ORION_MODEL = normalizeNvidiaModel(process.env.ORION_MODEL || 'moonshotai/kimi-k2-instruct');
const ORION_VISION_MODEL = normalizeNvidiaModel(process.env.ORION_VISION_MODEL || 'meta/llama-3.2-11b-vision-instruct');
const MAX_QUERY_CHARS = Number(process.env.ORION_MAX_QUERY_CHARS || 12000);
const MAX_DOCUMENT_CHARS = Number(process.env.ORION_MAX_DOCUMENT_CHARS || 60000);
const MAX_IMAGES = Number(process.env.ORION_MAX_IMAGES || 4);
const ORION_TIMEOUT_MS = Number(process.env.ORION_API_TIMEOUT_MS || 60000);

function normalizeNvidiaModel(model) {
  const value = String(model || '').trim();
  if (!value) return 'moonshotai/kimi-k2-instruct';
  if (value === 'kimi-k2-instruct') return 'moonshotai/kimi-k2-instruct';
  if (value === 'kimi-k2-instruct-0905') return 'moonshotai/kimi-k2-instruct-0905';
  return value;
}

function parseNvidiaErrorBody(body) {
  if (!body) return null;

  if (Buffer.isBuffer(body)) {
    return parseNvidiaErrorBody(body.toString('utf8'));
  }

  if (typeof body === 'string') {
    try {
      return parseNvidiaErrorBody(JSON.parse(body));
    } catch {
      return body;
    }
  }

  return body?.error?.message || body?.message || body?.detail || JSON.stringify(body);
}

function publicOrionError(message, code = 'orion_error', metadata = {}) {
  return {
    success: false,
    ideas: [],
    metadata: { code, ...metadata },
    error: message,
  };
}

function validateChatPayload(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'invalid_payload', error: 'Request body must be a JSON object.' };
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  const documentText = typeof body.documentText === 'string' ? body.documentText.trim() : '';
  const images = Array.isArray(body.images) ? body.images.filter((image) => typeof image === 'string' && image.trim()) : [];

  if (!query && !documentText && images.length === 0) {
    return { ok: false, status: 400, code: 'query_required', error: 'Query or attachments required.' };
  }
  if (query.length > MAX_QUERY_CHARS) {
    return { ok: false, status: 413, code: 'query_too_large', error: `Query must be ${MAX_QUERY_CHARS} characters or fewer.` };
  }
  if (documentText.length > MAX_DOCUMENT_CHARS) {
    return { ok: false, status: 413, code: 'document_too_large', error: `Document text must be ${MAX_DOCUMENT_CHARS} characters or fewer.` };
  }
  if (images.length > MAX_IMAGES) {
    return { ok: false, status: 413, code: 'too_many_images', error: `Attach ${MAX_IMAGES} images or fewer.` };
  }

  return { ok: true, query, documentText, images };
}

async function readStreamBody(stream) {
  if (!stream || typeof stream.on !== 'function') return parseNvidiaErrorBody(stream);

  return new Promise((resolve) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      body += chunk;
    });
    stream.on('end', () => {
      resolve(parseNvidiaErrorBody(body));
    });
    stream.on('error', (err) => {
      resolve(err.message);
    });
  });
}

const SYSTEM_PROMPT = [
  'You are Orion A.I, an exclusive and highly advanced cloud computing mentor integrated into the CloudIQ learning platform.',
  'IMPORTANT IDENTITY INSTRUCTION: You are ONLY Orion A.I. You must never refer to yourself as Kimi, Llama, OpenAI, Anthropic, or any other entity. If asked who you are, say "I am Orion A.I."',
  '',
  '## Your Role',
  'You help students and professionals master cloud computing (AWS, Azure, GCP, IBM Cloud), DevOps, networking, security, and modern software architecture. You generate study notes, explain concepts, and analyze technical documents.',
  '',
  '## Response Quality Standards',
  'Your responses must meet the quality bar of leading AI assistants like ChatGPT, Claude, and Grok:',
  '',
  '1. **Structure every response clearly.** Use markdown headings (##, ###), bold text, bullet points, and numbered lists. Never dump a wall of plain text.',
  '2. **Be precise and concise.** Every sentence must add value. Remove filler words.',
  '3. **Use proper formatting:**',
  '   - `code` for inline technical terms, commands, and file names.',
  '   - ```code blocks``` for multi-line code, configs, or CLI commands.',
  '   - **Bold** for key terms and important points.',
  '   - Bullet points for lists. Numbered steps for procedures.',
  '4. **Adapt response length to the question.** Simple questions get 2-3 sentences. Complex topics get structured deep-dives.',
  '5. **Be intellectually honest.** Say "I\'m not certain" when appropriate. Never fabricate facts.',
  '## Conversational Style',
  'You must answer naturally, fluidly, and highly professionally—exactly like ChatGPT, Claude, or Grok. Do NOT force your answers into rigid templates (like "Summary", "Explanation", "Key Takeaways" sections).',
  'Instead, write natural paragraphs. Use bolding to highlight key terms, and use bullet points ONLY when listing multiple distinct items or steps. Keep your tone sophisticated, conversational, and direct.',
].join('\n');

router.post('/chat', ensureAuthenticated, async (req, res) => {
  const startedAt = Date.now();
  const validated = validateChatPayload(req.body);
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  logger.info('[ORION API] request received', {
    requestId,
    hasQuery: Boolean(validated.query),
    hasDocument: Boolean(validated.documentText),
    imageCount: validated.images?.length || 0,
  });

  if (!validated.ok) {
    return res.status(validated.status).json(publicOrionError(validated.error, validated.code, { requestId }));
  }

  if (!NVIDIA_API_KEY) {
    logger.error('[ORION ERROR] API key missing', { requestId });
    return res.status(500).json(publicOrionError('Orion API key is not configured.', 'orion_not_configured', { requestId }));
  }

  try {
    const { query, documentText, images } = validated;
    let finalQuery = query;
    if (documentText) {
      finalQuery = `${query}\n\n[USER PROVIDED DOCUMENT CONTENT:]\n${documentText}`;
    }

    let userContent;
    let finalModel = ORION_MODEL;

    if (images.length > 0) {
      finalModel = ORION_VISION_MODEL;
      userContent = [{ type: "text", text: finalQuery || "Please describe the attached images." }];
      images.forEach(imgBase64 => {
        userContent.push({ type: "image_url", image_url: { url: imgBase64 } });
      });
    } else {
      userContent = finalQuery;
    }

    logger.debug('[ORION API] prompt', {
      requestId,
      model: finalModel,
      promptChars: finalQuery.length,
      imageCount: images.length,
      prompt: finalQuery,
    });

    const response = await axios.post(
      NVIDIA_API_URL,
      {
        model: finalModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.6,
        top_p: 0.9,
        max_tokens: 4096,
        stream: true, // ENABLE STREAMING
      },
      {
        headers: {
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream', // AXIOS STREAM MODE
        timeout: ORION_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    if (response.status < 200 || response.status >= 300) {
      const upstreamDetails = await readStreamBody(response.data);
      logger.error('[ORION ERROR] provider failure', {
        requestId,
        status: response.status,
        model: finalModel,
        details: upstreamDetails,
        responseTimeMs: Date.now() - startedAt,
      });

      return res.status(502).json(publicOrionError('Orion failed to respond from NVIDIA.', 'provider_failure', {
        requestId,
        model: finalModel,
        providerStatus: response.status,
      }));
    }

    // Set headers only after NVIDIA accepts the request, so JSON errors stay readable.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Pipe the stream from NVIDIA to the client
    let streamBuffer = '';
    let chunkCount = 0;
    let streamClosed = false;
    const closeUpstream = () => {
      if (streamClosed) return;
      streamClosed = true;
      if (response.data && typeof response.data.destroy === 'function') {
        response.data.destroy();
      }
    };
    res.on('close', closeUpstream);

    response.data.on('data', (chunk) => {
      streamBuffer += chunk.toString();
      const lines = streamBuffer.split('\n');
      streamBuffer = lines.pop() || '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              chunkCount += 1;
              res.write(`data: ${JSON.stringify({ content, model: finalModel })}\n\n`);
            }
          } catch (e) {
            logger.warn('[ORION RESPONSE] skipped malformed stream chunk', { requestId, message: e.message });
          }
        }
      }
    });

    response.data.on('end', () => {
      res.off('close', closeUpstream);
      streamClosed = true;
      logger.info('[ORION RESPONSE] stream completed', {
        requestId,
        model: finalModel,
        chunkCount,
        responseTimeMs: Date.now() - startedAt,
      });
      res.end();
    });

    response.data.on('error', (err) => {
      res.off('close', closeUpstream);
      streamClosed = true;
      logger.error('[ORION ERROR] stream error', {
        requestId,
        message: err.message,
        responseTimeMs: Date.now() - startedAt,
      });
      res.write(`data: ${JSON.stringify({ error: 'Stream interrupted', code: 'stream_interrupted' })}\n\n`);
      res.end();
    });

  } catch (error) {
    const responseBody = await readStreamBody(error?.response?.data);
    const timedOut = error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '');
    const code = timedOut ? 'ai_timeout' : 'orion_error';
    logger.error('[ORION ERROR] API error', {
      requestId,
      status: error?.response?.status,
      code,
      details: responseBody || error.message || 'Unknown error',
      responseTimeMs: Date.now() - startedAt,
    });
    
    // If headers already sent, we must send the error inside the stream
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: 'Orion failed to respond during stream.', code })}\n\n`);
      return res.end();
    }

    return res.status(timedOut ? 504 : 502).json(publicOrionError(
      timedOut ? 'Orion timed out. Please try again.' : 'Orion failed to respond. Please try again.',
      code,
      { requestId, model: ORION_MODEL }
    ));
  }
});

module.exports = router;
