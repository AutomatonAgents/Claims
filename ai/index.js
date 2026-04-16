// ai/index.js — Multi-provider AI abstraction layer for AutomatON
// Factory + shared utilities. Provider modules: anthropic.js, google.js, openai.js

const path = require('path');
const fs = require('fs');

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const MODEL_OVERRIDE = process.env.AI_MODEL || null;

// Default models per provider
const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  google: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
};

function getModel() {
  return MODEL_OVERRIDE || DEFAULT_MODELS[PROVIDER] || DEFAULT_MODELS.anthropic;
}

function getProviderInfo() {
  return { provider: PROVIDER, model: getModel() };
}

// Robust JSON extraction from AI responses (handles both objects and arrays)
function extractJSON(rawText) {
  let text = rawText.trim();
  text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  text = text.trim();
  // Try direct parse first
  try { return JSON.parse(text); } catch {}
  // Find first { or [ and matching last } or ]
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let start, endChar;
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    start = arrStart; endChar = ']';
  } else if (objStart !== -1) {
    start = objStart; endChar = '}';
  } else {
    throw new Error('No JSON found in AI response');
  }
  const end = text.lastIndexOf(endChar);
  if (end <= start) throw new Error('No JSON found in AI response');
  return JSON.parse(text.substring(start, end + 1));
}

// Timeout wrapper
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`[${PROVIDER}] AI timeout (${ms}ms)`)), ms))
  ]);
}

// Load the active provider module
let activeProvider = null;
function getProvider() {
  if (!activeProvider) {
    const validProviders = ['anthropic', 'google', 'openai'];
    if (!validProviders.includes(PROVIDER)) {
      throw new Error('AI provider not configured correctly.');
    }
    try {
      activeProvider = require(`./${PROVIDER}`);
    } catch (err) {
      console.error(`[ai] Failed to load provider '${PROVIDER}':`, err.message);
      throw new Error('AI provider not configured correctly.');
    }
  }
  return activeProvider;
}

// Credentials-only check (NO fixture awareness — routes handle that)
function isAvailable() {
  switch (PROVIDER) {
    case 'anthropic': {
      if (process.env.ANTHROPIC_API_KEY) return true;
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (!homeDir) return false;
      try {
        const credPath = path.join(homeDir, '.claude', '.credentials.json');
        const content = fs.readFileSync(credPath, 'utf8');
        const creds = JSON.parse(content);
        return !!(creds && (creds.claudeAiOauth || creds.oauthAccessToken));
      } catch { return false; }
    }
    case 'google':
      return !!process.env.GOOGLE_AI_API_KEY;
    case 'openai':
      return !!process.env.OPENAI_API_KEY;
    default:
      return false;
  }
}

// Privacy statement per provider (in Bulgarian)
function getPrivacyStatement() {
  switch (PROVIDER) {
    case 'anthropic':
      return 'API доставчикът не използва API данни за обучение по подразбиране.';
    case 'google':
      return 'При безплатен план данните може да се използват за подобряване на услугите. При платен план — не.';
    case 'openai':
      return 'API доставчикът не използва API данни за обучение по подразбиране.';
    default:
      return '';
  }
}

// Configurable default vision timeout
const defaultVisionTimeout = parseInt(process.env.AI_VISION_TIMEOUT) || 60000;

// Retry wrapper for transient errors (429 rate limit, 5xx server errors)
async function withRetry(fn, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err.statusCode || 0;
      const isRetryable = status === 429 || status >= 500;
      if (attempt < maxRetries && isRetryable) {
        const delay = (attempt + 1) * 2000;
        console.warn(`[ai] Retrying after ${delay}ms (attempt ${attempt + 1}, status ${status})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// Main exports — callVision returns parsed JSON, callChat returns raw text
async function callVision(fileBuffer, mimeType, prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 2000;
  const timeoutMs = opts.timeoutMs || defaultVisionTimeout;
  const provider = getProvider();
  return withRetry(async () => {
    const rawText = await withTimeout(
      provider.callVision(fileBuffer, mimeType, prompt, { maxTokens, model: getModel() }),
      timeoutMs, 'vision'
    );
    return extractJSON(rawText);
  });
}

async function callChat(systemPrompt, userMessage, opts = {}) {
  const maxTokens = opts.maxTokens || 500;
  const timeoutMs = opts.timeoutMs || 15000;
  const provider = getProvider();
  return withRetry(async () => {
    return withTimeout(
      provider.callChat(systemPrompt, userMessage, { maxTokens, model: getModel() }),
      timeoutMs, 'chat'
    );
  });
}

console.log(`[ai] Provider: ${PROVIDER}, Model: ${getModel()}, Available: ${isAvailable()}`);

module.exports = { callVision, callChat, isAvailable, getProviderInfo, getPrivacyStatement, extractJSON };
