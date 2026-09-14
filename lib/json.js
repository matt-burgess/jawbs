import { callAI } from './aiRouter.js';

export function stripFences(text) {
  if (!text) return '';
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

export function tryParseJson(text) {
  const cleaned = stripFences(text);
  return JSON.parse(cleaned);
}

// Provider-agnostic JSON caller. Dispatches through aiRouter — same
// contract, works whether the user selected Anthropic, OpenAI, or
// Gemini. Retries once on parse failure with the parse error appended
// so the model can self-correct. Returns { result, usage, model,
// retried } — same shape callers expected from callJsonAnthropic.
export async function callJsonAnthropic({ apiKey, model, system, userMessage, maxTokens = 4096 }) {
  const first = await callAI({
    apiKey, model, system, maxTokens,
    messages: [{ role: 'user', content: userMessage }],
  });
  const firstText = first.text;

  try {
    return {
      result: tryParseJson(firstText),
      usage: first.usage || null,
      model: first.model,
      retried: false,
    };
  } catch (parseError) {
    const retry = await callAI({
      apiKey, model, system, maxTokens,
      messages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: firstText },
        {
          role: 'user',
          content: `That failed to parse as JSON: ${parseError.message}. Return ONLY valid JSON, no prose, no markdown fences.`,
        },
      ],
    });
    const retryText = retry.text;
    try {
      return {
        result: tryParseJson(retryText),
        usage: retry.usage || null,
        model: retry.model,
        retried: true,
      };
    } catch (secondError) {
      throw new Error(
        `Model returned non-JSON twice. First error: ${parseError.message}. Second: ${secondError.message}. Raw output: ${retryText.slice(0, 500)}`
      );
    }
  }
}
// Backwards-compatible alias for any importer that grabbed the old name.
export const callJsonAI = callJsonAnthropic;

// Middle-truncate long text keeping opening and end (usually intro + requirements).
export function truncateMiddle(text, maxChars = 15000) {
  if (!text || text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return text.slice(0, half) + '\n\n[... middle truncated ...]\n\n' + text.slice(-half);
}
