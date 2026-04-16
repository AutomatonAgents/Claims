// ai/google.js — Google Gemini provider for AutomatON AI abstraction
// Uses @google/genai SDK (official, NOT the legacy @google/generative-ai)

const { GoogleGenAI } = require('@google/genai');

function getClient() {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY environment variable is not set');
  return new GoogleGenAI({ apiKey });
}

/**
 * Vision call — process an image or PDF with a text prompt.
 * Gemini supports native PDF via inlineData.
 * Returns raw text from response (JSON parsing done in index.js).
 */
async function callVision(fileBuffer, mimeType, prompt, { maxTokens, model }) {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType,
            data: fileBuffer.toString('base64'),
          },
        },
        { text: prompt },
      ],
    }],
    config: {
      maxOutputTokens: maxTokens,
    },
  });

  const text = response.text;
  if (!text) throw new Error('No text in Google AI response');
  return text;
}

/**
 * Chat call — system instruction + user message.
 * Returns raw text from response.
 */
async function callChat(systemPrompt, userMessage, { maxTokens, model }) {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [{ text: userMessage }],
    }],
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
    },
  });

  const text = response.text;
  return text ? text.trim() : '';
}

module.exports = { callVision, callChat };
