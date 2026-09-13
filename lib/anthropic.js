const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class AnthropicError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
    this.body = body;
  }
}

export async function callAnthropic({ apiKey, model, system, messages, maxTokens = 4096 }) {
  if (!apiKey) {
    throw new AnthropicError('API key is not configured. Open Settings and paste your key.');
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
  } catch (e) {
    throw new AnthropicError(
      `Network error reaching api.anthropic.com. In Brave, lower Shields for this extension or add api.anthropic.com to the exceptions. Original: ${e.message}`
    );
  }

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!res.ok) {
    const detail = body?.error?.message || (typeof body === 'string' ? body : JSON.stringify(body));
    throw new AnthropicError(`Anthropic API ${res.status}: ${detail}`, { status: res.status, body });
  }

  return body;
}

export function extractText(response) {
  return (response.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
}
