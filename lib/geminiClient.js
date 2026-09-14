// Google Gemini API client — uses the v1beta generateContent endpoint.
// Key travels in the querystring (Google's convention). Response shape
// differs significantly from Anthropic's; the aiRouter normalizes both.

export class GeminiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.body = body;
  }
}

export async function callGemini({ apiKey, model, system, messages, maxTokens = 4096 }) {
  if (!apiKey) {
    throw new GeminiError('Gemini API key is not configured. Open Settings → AI → Gemini key.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Gemini uses 'user' and 'model' roles. Every Anthropic-style user
  // message becomes a Gemini user turn; every assistant becomes model.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new GeminiError(`Network error reaching generativelanguage.googleapis.com. Original: ${e.message}`);
  }

  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { out = text; }

  if (!res.ok) {
    const detail = out?.error?.message || (typeof out === 'string' ? out : JSON.stringify(out));
    throw new GeminiError(`Gemini API ${res.status}: ${detail}`, { status: res.status, body: out });
  }

  return out;
}

export function extractGeminiText(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => p?.text || '').join('').trim();
}

// Normalize Gemini's usageMetadata to the same { input_tokens,
// output_tokens } shape callers use for Anthropic.
export function normalizeGeminiUsage(response) {
  const u = response?.usageMetadata;
  if (!u) return null;
  return {
    input_tokens: u.promptTokenCount ?? 0,
    output_tokens: u.candidatesTokenCount ?? 0,
  };
}
