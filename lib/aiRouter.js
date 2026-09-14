// Provider-agnostic AI dispatcher. Every cloud call goes through
// callAI() — the router reads the active provider from storage,
// invokes the right client, and returns a normalized result:
//
//   { provider, text, usage: { input_tokens, output_tokens }, model, raw }
//
// Legacy callers that need the raw Anthropic-style response object
// can read result.raw. usage is always shaped { input_tokens,
// output_tokens } across providers so cost tracking doesn't branch.

import { callAnthropic, extractText as extractAnthropicText } from './anthropic.js';
import { callOpenAI, extractOpenAIText, normalizeOpenAIUsage } from './openaiClient.js';
import { callGemini, extractGeminiText, normalizeGeminiUsage } from './geminiClient.js';
import {
  getCloudProvider,
  getApiKey,
  getOpenAIKey,
  getGeminiKey,
} from './store.js';
import { defaultModelForProvider, defaultDiagnosticModelForProvider } from './models.js';

// Resolve the key for whichever provider is currently active.
export async function getActiveCloudKey() {
  const provider = await getCloudProvider();
  if (provider === 'openai') return await getOpenAIKey();
  if (provider === 'gemini') return await getGeminiKey();
  return await getApiKey();
}

// Coerce a caller-supplied model to one the active provider actually
// understands. Every caller currently threads Anthropic-style model
// names through the router; when the user picks a different provider,
// the router substitutes that provider's default for the same feature.
// A follow-up patch can add per-feature routing per provider — for now
// each provider gets one default model.
function resolveModel(provider, requestedModel) {
  if (!requestedModel) return defaultModelForProvider(provider);
  if (provider === 'anthropic') return requestedModel;
  // For non-Anthropic providers, ignore the requested Anthropic model
  // string and use that provider's default. If the caller is a
  // diagnostic (short prompt, low tokens), use the fast tier.
  if (/haiku|small|fast/i.test(String(requestedModel))) {
    return defaultDiagnosticModelForProvider(provider);
  }
  return defaultModelForProvider(provider);
}

export async function callAI({ apiKey, model, system, messages, maxTokens = 4096 }) {
  const provider = await getCloudProvider();
  const key = apiKey || (await getActiveCloudKey());
  const resolvedModel = resolveModel(provider, model);

  if (provider === 'openai') {
    const raw = await callOpenAI({ apiKey: key, model: resolvedModel, system, messages, maxTokens });
    return {
      provider,
      text: extractOpenAIText(raw),
      usage: normalizeOpenAIUsage(raw),
      model: resolvedModel,
      raw,
    };
  }
  if (provider === 'gemini') {
    const raw = await callGemini({ apiKey: key, model: resolvedModel, system, messages, maxTokens });
    return {
      provider,
      text: extractGeminiText(raw),
      usage: normalizeGeminiUsage(raw),
      model: resolvedModel,
      raw,
    };
  }
  // Default: Anthropic.
  const raw = await callAnthropic({ apiKey: key, model: resolvedModel, system, messages, maxTokens });
  return {
    provider,
    text: extractAnthropicText(raw),
    usage: raw?.usage || null, // Anthropic already returns input_tokens/output_tokens
    model: resolvedModel,
    raw,
  };
}

export function providerLabel(provider) {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'gemini') return 'Google Gemini';
  return 'Anthropic Claude';
}
