/**
 * Prompt budgeting for wiki generation.
 *
 * `estimateTokens` (chars / 4) undershoots for identifier- and path-heavy
 * text, so a prompt it calls "small" can still overflow the model's context
 * window. Everything here uses a more pessimistic estimate and reserves room
 * for the completion, the system prompt and a safety margin.
 */

/** Pessimistic characters-per-token ratio for code, paths and identifiers. */
const SAFE_CHARS_PER_TOKEN = 3;
/** Tokens held back for tokenizer variance and request framing. */
const SAFETY_MARGIN_TOKENS = 2_000;
/** A prompt never gets less than this, however small the configured window. */
const MIN_PROMPT_TOKENS = 4_000;

export const TRUNCATION_NOTICE = '\n\n... (truncated to fit the model context window)';

export function estimateTokensSafe(text: string): number {
  return Math.ceil(text.length / SAFE_CHARS_PER_TOKEN);
}

/**
 * Tokens available for the user prompt: the context window minus the
 * completion budget, the system prompt and a safety margin.
 */
export function promptTokenBudget(
  contextWindow: number,
  maxCompletionTokens: number,
  systemPrompt = '',
): number {
  const budget =
    contextWindow - maxCompletionTokens - estimateTokensSafe(systemPrompt) - SAFETY_MARGIN_TOKENS;
  return Math.max(MIN_PROMPT_TOKENS, budget);
}

/** Cut `text` to at most `maxTokens` (pessimistic estimate), marking the cut. */
export function clipToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens) * SAFE_CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - TRUNCATION_NOTICE.length);
  return text.slice(0, keep) + TRUNCATION_NOTICE;
}

/**
 * Fit several sections into one shared token budget. Sections under their
 * equal share keep their text, and the room they leave over is split among
 * the longer ones, so a few large sections cannot starve the small ones.
 */
export function fitSectionsToBudget(sections: string[], maxTokens: number): string[] {
  const joinCost = 1; // newline-ish separators are cheap; keep one token each
  let remaining = Math.max(0, maxTokens - sections.length * joinCost);
  if (sections.reduce((sum, s) => sum + estimateTokensSafe(s), 0) <= remaining) return sections;

  const order = sections
    .map((text, index) => ({ index, tokens: estimateTokensSafe(text) }))
    .sort((a, b) => a.tokens - b.tokens);
  const result = [...sections];
  let left = order.length;
  for (const { index, tokens } of order) {
    const share = Math.floor(remaining / left);
    if (tokens > share) result[index] = clipToTokens(sections[index], share);
    remaining -= Math.min(tokens, share);
    left -= 1;
  }
  return result;
}

/** Keep at most `maxLines` lines of a newline-separated block. */
export function capLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more omitted)`;
}
