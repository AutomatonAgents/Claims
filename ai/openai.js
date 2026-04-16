// ai/openai.js — OpenAI provider for AutomatON AI abstraction
// Uses the official openai SDK

const OpenAI = require('openai');

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');
  return new OpenAI({ apiKey });
}

/**
 * Vision call — process an image or PDF with a text prompt.
 * For images: uses data URI in image_url content part.
 * For PDFs: uses file input (OpenAI supports native PDF via input array).
 * Returns raw text from response (JSON parsing done in index.js).
 */
async function callVision(fileBuffer, mimeType, prompt, { maxTokens, model }) {
  const client = getClient();
  const base64Data = fileBuffer.toString('base64');

  let contentParts;

  if (mimeType === 'application/pdf') {
    // OpenAI supports PDF via file content part
    contentParts = [
      {
        type: 'file',
        file: {
          filename: 'document.pdf',
          file_data: `data:application/pdf;base64,${base64Data}`,
        },
      },
      { type: 'text', text: prompt },
    ];
  } else {
    // Images: use data URI in image_url
    contentParts = [
      {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Data}`,
        },
      },
      { type: 'text', text: prompt },
    ];
  }

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: contentParts,
    }],
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error('No text in OpenAI response');
  return text;
}

/**
 * Chat call — system + user message.
 * Returns raw text from response.
 */
async function callChat(systemPrompt, userMessage, { maxTokens, model }) {
  const client = getClient();

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  const text = response.choices?.[0]?.message?.content;
  return text ? text.trim() : '';
}

module.exports = { callVision, callChat };
