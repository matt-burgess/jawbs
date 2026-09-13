// Local Ollama client. Talks to the daemon at localhost:11434 from the
// service worker. Requires host_permissions on http://localhost:11434/*.

const OLLAMA_BASE = 'http://localhost:11434';

export class OllamaError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
  }
}

export async function getVersion(timeoutMs = 2500) {
  const r = await fetchWithTimeout(`${OLLAMA_BASE}/api/version`, {}, timeoutMs);
  if (!r.ok) throw new OllamaError(`version check failed: ${r.status}`, { status: r.status });
  return (await r.json()).version;
}

export async function isReachable(timeoutMs = 1500) {
  try {
    const r = await fetchWithTimeout(`${OLLAMA_BASE}/api/version`, {}, timeoutMs);
    return r.ok;
  } catch { return false; }
}

export async function listModels() {
  const r = await fetchWithTimeout(`${OLLAMA_BASE}/api/tags`, {}, 4000);
  if (!r.ok) throw new OllamaError(`tags failed: ${r.status}`, { status: r.status });
  const data = await r.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    modified: m.modified_at,
    family: m.details?.family || null,
    param_size: m.details?.parameter_size || null,
    quant: m.details?.quantization_level || null,
  }));
}

async function chat({ model, system, messages, options = {}, timeoutMs = 120_000 }) {
  const r = await fetchWithTimeout(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
      stream: false,
      options,
    }),
  }, timeoutMs);
  if (!r.ok) {
    const text = await r.text();
    throw new OllamaError(`chat ${r.status}: ${text}`, { status: r.status });
  }
  const data = await r.json();
  return {
    text: data.message?.content || '',
    model: data.model,
    usage: {
      input_tokens: data.prompt_eval_count || 0,
      output_tokens: data.eval_count || 0,
    },
  };
}

// Call Ollama and parse the response as JSON. Mirrors callJsonAnthropic's
// contract so runners can swap providers by shape.
export async function callOllamaJson({ model, system, userMessage, maxTokens = 1500, temperature = 0.4 }) {
  const r = await chat({
    model,
    system,
    messages: [{ role: 'user', content: userMessage }],
    options: { num_predict: maxTokens, temperature },
  });
  const cleaned = stripFences(r.text);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new OllamaError(`response was not valid JSON (${e.message}). Local model may be too small for this schema. Raw: ${cleaned.slice(0, 200)}`);
  }
  return { result: parsed, usage: r.usage, model: r.model, retried: false };
}

// Plain-text version for features that don't return JSON (e.g., Prep brief markdown).
export async function callOllamaText({ model, system, userMessage, maxTokens = 3000, temperature = 0.4 }) {
  const r = await chat({
    model,
    system,
    messages: [{ role: 'user', content: userMessage }],
    options: { num_predict: maxTokens, temperature },
  });
  return { text: r.text, usage: r.usage, model: r.model };
}

function stripFences(text) {
  if (!text) return '';
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}
