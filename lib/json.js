import { callAnthropic, extractText, AnthropicError } from './anthropic.js';

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

// Call Anthropic, expect JSON back, retry once on parse failure with the
// parse error appended so the model can self-correct. Returns the parsed
// object plus usage/model metadata.
export async function callJsonAnthropic({ apiKey, model, system, userMessage, maxTokens = 4096 }) {
  const first = await callAnthropic({
    apiKey, model, system, maxTokens,
    messages: [{ role: 'user', content: userMessage }],
  });
  const firstText = extractText(first);

  try {
    return {
      result: tryParseJson(firstText),
      usage: first.usage || null,
      model, retried: false,
    };
  } catch (parseError) {
    const retry = await callAnthropic({
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
    const retryText = extractText(retry);
    try {
      return {
        result: tryParseJson(retryText),
        usage: retry.usage || null,
        model, retried: true,
      };
    } catch (secondError) {
      throw new AnthropicError(
        `Model returned non-JSON twice. First error: ${parseError.message}. Second: ${secondError.message}. Raw output: ${retryText.slice(0, 500)}`
      );
    }
  }
}

// Middle-truncate long text keeping opening and end (usually intro + requirements).
export function truncateMiddle(text, maxChars = 15000) {
  if (!text || text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return text.slice(0, half) + '\n\n[... middle truncated ...]\n\n' + text.slice(-half);
}
