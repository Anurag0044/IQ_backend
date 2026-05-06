const express = require('express');
const axios = require('axios');
const { DuckDuckGoSearch } = require('@langchain/community/tools/duckduckgo_search');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || '';
const PRIMARY_MODEL = process.env.ORION_PRIMARY_MODEL || 'llama3.1';
const FALLBACK_MODEL = process.env.ORION_FALLBACK_MODEL || 'phi3.5';
const LOGIC_MODEL = process.env.ORION_LOGIC_MODEL || 'phi4-mini';
const REQUIRE_NGROK = (process.env.ORION_REQUIRE_NGROK || 'true').toLowerCase() !== 'false';

const modelMap = {
  'llama-3.1': PRIMARY_MODEL,
  'phi-3.5': FALLBACK_MODEL,
  'phi-4-mini': LOGIC_MODEL,
  tinyllama: 'tinyllama',
  'gemma-2': 'gemma2:2b',
};

function pickModel(modelId, query = '') {
  if (modelId && modelMap[modelId]) return modelMap[modelId];

  const looksLikeMath = /(\bsolve\b|\bcalculate\b|\bmath\b|\bequation\b|\bintegral\b|\bderivative\b|\bproof\b|\bprobability\b|[\d\+\-\*\/\(\)=]{4,})/i.test(query);
  if (looksLikeMath) return LOGIC_MODEL;
  return PRIMARY_MODEL;
}

function normalizeSearchResults(raw) {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((entry) => ({
        title: entry.title || 'Untitled source',
        url: entry.link || entry.url || '',
        snippet: entry.snippet || entry.body || '',
      }))
      .filter((entry) => entry.url);
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return normalizeSearchResults(parsed);
    } catch (e) {
      return [];
    }
  }

  return [];
}

async function fetchRagContext(query) {
  const searchTool = new DuckDuckGoSearch({ maxResults: 5 });

  try {
    const raw = await searchTool.invoke(query);
    const normalized = normalizeSearchResults(raw).slice(0, 5);

    const context = normalized
      .map((item, idx) => {
        return `[Source ${idx + 1}] ${item.title}\nURL: ${item.url}\nSnippet: ${item.snippet}`;
      })
      .join('\n\n');

    return {
      sources: normalized.map((item) => item.url),
      context: context || 'No strong sources found, answering from general knowledge',
      usedFallbackContext: normalized.length === 0,
    };
  } catch (error) {
    console.warn('[ORION] DuckDuckGo retrieval failed:', error.message);
    return {
      sources: [],
      context: 'No strong sources found, answering from general knowledge',
      usedFallbackContext: true,
    };
  }
}

function buildSystemPrompt(context) {
  return [
    'You are an advanced AI system with tool-augmented reasoning and RAG capabilities.',
    '',
    'SYSTEM ROLE:',
    '- Act like a high-end AI product (Perplexity / ChatGPT Pro style).',
    '- Combine reasoning, retrieval, and structured explanation.',
    '- Prioritize accuracy, clarity, and usefulness.',
    '',
    'MODEL CONTEXT:',
    '- Primary reasoning model: Llama 3.1',
    '- Fallback model: Phi 3.5',
    '- Specialized logic/math: Phi 4-mini',
    '',
    'INSTRUCTIONS:',
    '1) Understand user intent and break complex queries into clear parts.',
    '2) Use retrieved context first. Merge multiple sources and ignore irrelevant snippets.',
    '3) Reason internally, but do not reveal private chain-of-thought.',
    '4) Output MUST use exactly this structure:',
    '### 🔹 Summary',
    '- 2–4 lines max',
    '',
    '### 🔹 Detailed Explanation',
    '- Clear and structured sections',
    '',
    '### 🔹 Key Insights',
    '- Bullet points',
    '',
    '### 🔹 Sources',
    '- List only real URLs from retrieved data.',
    '',
    '5) Never hallucinate sources. If uncertain, say "Based on available data..."',
    '6) Keep tone professional and UI-friendly.',
    '7) If no useful data, explicitly say: "No strong sources found, answering from general knowledge".',
    '8) If data conflicts, mention both views briefly.',
    '',
    'RAG CONTEXT (highest priority):',
    context,
  ].join('\n');
}

function validateOllamaBaseUrl() {
  if (!OLLAMA_BASE_URL) {
    return {
      ok: false,
      reason: 'OLLAMA_BASE_URL is missing. Set it to your ngrok HTTPS URL for Ollama.',
    };
  }

  const isHttps = OLLAMA_BASE_URL.startsWith('https://');
  const isNgrok = /ngrok/i.test(OLLAMA_BASE_URL);

  if (REQUIRE_NGROK && (!isHttps || !isNgrok)) {
    return {
      ok: false,
      reason: 'OLLAMA_BASE_URL must be an https ngrok URL (example: https://abc123.ngrok-free.app).',
    };
  }

  return { ok: true };
}

router.post('/chat', ensureAuthenticated, async (req, res) => {
  const query = (req.body?.query || '').toString().trim();
  const requestedModelId = (req.body?.model || '').toString().trim();

  if (!query) {
    return res.status(400).json({ success: false, error: 'Query is required.' });
  }

  const rag = await fetchRagContext(query);
  const resolvedModel = pickModel(requestedModelId, query);
  const systemPrompt = buildSystemPrompt(rag.context);
  const baseUrlValidation = validateOllamaBaseUrl();

  if (!baseUrlValidation.ok) {
    return res.status(400).json({
      success: false,
      error: baseUrlValidation.reason,
    });
  }

  const candidateModels = requestedModelId === 'gemma-2'
    ? Array.from(new Set([resolvedModel, 'tinyllama:latest']))
    : Array.from(new Set([resolvedModel, FALLBACK_MODEL, 'tinyllama:latest']));
  let lastError = null;

  for (const modelName of candidateModels) {
    try {
      const ollamaResponse = await axios.post(
        `${OLLAMA_BASE_URL}/api/chat`,
        {
          model: modelName,
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query },
          ],
          options: {
            temperature: 0.2,
            num_predict: 300,
          },
        },
        {
          timeout: 25000,
          headers: {
            'ngrok-skip-browser-warning': 'true',
            'User-Agent': 'CloudIQ-Orion/1.0',
          },
        }
      );

      const answer = ollamaResponse?.data?.message?.content || 'Based on available data, I could not generate a complete response.';
      return res.json({
        success: true,
        answer,
        sources: rag.sources,
        modelUsed: modelName,
        usedFallbackContext: rag.usedFallbackContext,
      });
    } catch (error) {
      const details = error?.response?.data?.error || error.message || 'Unknown Ollama error';
      lastError = details;
      const isMemoryError = /memory|ram|required/i.test(details);
      const isTimeoutOrServerError = /timeout|status code 500|connection reset/i.test(details);
      const isModelNotFound = /model .* not found/i.test(details);
      if (!isMemoryError && !isTimeoutOrServerError && !isModelNotFound) break;
    }
  }

  console.error('[ORION] Ollama request failed:', lastError);
  return res.status(502).json({
    success: false,
    error: 'Failed to reach Ollama. Verify OLLAMA_BASE_URL (can be your ngrok HTTPS URL).',
    details: lastError || 'Unknown error while contacting Ollama',
  });
});

module.exports = router;
