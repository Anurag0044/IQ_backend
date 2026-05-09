const express = require('express');
const axios = require('axios');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

const NVIDIA_API_URL = process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_API_KEY = process.env.ORION_API_KEY || process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || '';
const ORION_MODEL = normalizeNvidiaModel(process.env.ORION_MODEL || 'moonshotai/kimi-k2-instruct');
const ORION_VISION_MODEL = normalizeNvidiaModel(process.env.ORION_VISION_MODEL || 'meta/llama-3.2-11b-vision-instruct');

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
  const query = (req.body?.query || '').toString().trim();
  const documentText = (req.body?.documentText || '').toString().trim();
  const images = Array.isArray(req.body?.images) ? req.body.images : [];

  if (!query && !documentText && images.length === 0) {
    return res.status(400).json({ success: false, error: 'Query or attachments required.' });
  }

  if (!NVIDIA_API_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Orion API key is not configured.',
    });
  }

  try {
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
        timeout: Number(process.env.ORION_API_TIMEOUT_MS || 60000),
        validateStatus: () => true,
      }
    );

    if (response.status < 200 || response.status >= 300) {
      const upstreamDetails = await readStreamBody(response.data);
      console.error('[ORION] NVIDIA API error:', {
        status: response.status,
        model: finalModel,
        details: upstreamDetails,
      });

      return res.status(502).json({
        success: false,
        error: 'Orion failed to respond from NVIDIA.',
        details: upstreamDetails || `NVIDIA returned HTTP ${response.status}`,
        model: finalModel,
      });
    }

    // Set headers only after NVIDIA accepts the request, so JSON errors stay readable.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Pipe the stream from NVIDIA to the client
    let streamBuffer = '';
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
              res.write(`data: ${JSON.stringify({ content, model: finalModel })}\n\n`);
            }
          } catch (e) {
            console.warn('[ORION] Skipped malformed stream chunk:', e.message);
          }
        }
      }
    });

    response.data.on('end', () => {
      res.end();
    });

    response.data.on('error', (err) => {
      console.error('[ORION] Stream error:', err);
      res.write(`data: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`);
      res.end();
    });

  } catch (error) {
    const responseBody = await readStreamBody(error?.response?.data);
    const details = responseBody || error.message || 'Unknown error';
    console.error('[ORION] API error:', {
      status: error?.response?.status,
      details,
    });
    
    // If headers already sent, we must send the error inside the stream
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: 'Orion failed to respond during stream.' })}\n\n`);
      return res.end();
    }

    return res.status(502).json({
      success: false,
      error: 'Orion failed to respond. Please try again.',
      details,
      model: ORION_MODEL,
    });
  }
});

module.exports = router;
