// ai/anthropic.js — Anthropic Claude provider for AutomatON AI abstraction
// Preserves exact dual auth path: ANTHROPIC_API_KEY direct OR claudeAuth.js OAuth

const Anthropic = require('@anthropic-ai/sdk');

async function getClient() {
  if (process.env.ANTHROPIC_API_KEY) {
    // Direct API key for cloud deployment (Railway/Render)
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  // OAuth flow for local dev
  const { getAccessToken } = require('../claudeAuth');
  const token = await getAccessToken();

  return new Anthropic({
    apiKey: 'oauth',
    defaultHeaders: {
      'anthropic-beta': 'oauth-2025-04-20',
    },
    fetch: async (url, init) => {
      const headers = new Headers(init.headers || {});
      headers.delete('x-api-key');
      headers.set('authorization', `Bearer ${token}`);
      return globalThis.fetch(url, { ...init, headers });
    },
  });
}

/**
 * Vision call — process an image or PDF with a text prompt.
 * Returns raw text from response (JSON parsing done in index.js).
 */
async function callVision(fileBuffer, mimeType, prompt, { maxTokens, model }) {
  const client = await getClient();

  // IMPORTANT: PDFs use type:'document', images use type:'image'
  const contentBlock =
    mimeType === 'application/pdf'
      ? {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: fileBuffer.toString('base64'),
          },
        }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType, // 'image/jpeg' or 'image/png'
            data: fileBuffer.toString('base64'),
          },
        };

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [contentBlock, { type: 'text', text: prompt }],
    }],
  });

  const textContent = response.content.find(c => c.type === 'text');
  if (!textContent) throw new Error('No text in Anthropic response');
  return textContent.text;
}

/**
 * Chat call — system + user message.
 * Returns raw text from response.
 */
async function callChat(systemPrompt, userMessage, { maxTokens, model }) {
  const client = await getClient();

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textContent = response.content.find(c => c.type === 'text');
  return textContent ? textContent.text.trim() : '';
}

module.exports = { callVision, callChat };
