// OpenAI Chat Completions client. Mirrors the shape of anthropic.js so
// the aiRouter can dispatch to it interchangeably. Response gets
// converted to a common shape at the router layer.

const API_URL = 'https://api.openai.com/v1/chat/completions';

export class OpenAIError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
    this.body = body;
  }
}

export async function callOpenAI({ apiKey, model, system, messages, maxTokens = 4096 }) {
  if (!apiKey) {
    throw new OpenAIError('OpenAI API key is not configured. Open Settings → AI → OpenAI key.');
  }

  // Prepend the system prompt as a system role message — OpenAI's chat
  // format keeps system content inline with the message array.
  const oaMessages = [];
  if (system) oaMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    // Anthropic uses 'assistant' and 'user' — same names OpenAI uses.
    oaMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: oaMessages,
        // GPT-4o family uses max_completion_tokens; older models used
        // max_tokens. Send both for forward/back compat.
        max_completion_tokens: maxTokens,
        max_tokens: maxTokens,
      }),
    });
  } catch (e) {
    throw new OpenAIError(`Network error reaching api.openai.com. Original: ${e.message}`);
  }

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!res.ok) {
    const detail = body?.error?.message || (typeof body === 'string' ? body : JSON.stringify(body));
    throw new OpenAIError(`OpenAI API ${res.status}: ${detail}`, { status: res.status, body });
  }

  return body;
}

export function extractOpenAIText(response) {
  return String(response?.choices?.[0]?.message?.content || '').trim();
}

// Normalize usage counts to the same shape callers use for Anthropic —
// { input_tokens, output_tokens } — so cost tracking doesn't branch.
export function normalizeOpenAIUsage(response) {
  const u = response?.usage;
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
  };
}
