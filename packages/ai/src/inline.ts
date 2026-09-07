/**
 * Inline (ghost-text) completion contract + post-processing (single place).
 *
 * Small models routinely ignore "code only, no fences" instructions: they
 * emit <think> rambles, explanations, and — worst case — echo the suffix
 * back instead of a continuation. So the prompt demands ONE fenced block
 * and this cleaner enforces it:
 *   1. strip <think> blocks (closed or unclosed),
 *   2. take the first fenced block's inner code (any label),
 *   3. else accept short raw output only (long prose => ""),
 *   4. cut echoed suffix, drop empties.
 * Showing nothing beats showing garbage ghost text.
 */

export const INLINE_FENCE_INSTRUCTION =
  "You are a code completion engine. Output ONLY the exact code that continues <prefix> and comes immediately before <suffix>. " +
  "Wrap only the continuation code in a single ```suggestion fenced block and output nothing else — " +
  "no explanations, no <think> tags, no other fences. Never repeat the prefix or suffix.";

/** Max chars accepted for unfenced raw output (longer => rambling prose). */
export const MAX_RAW_INLINE_CHARS = 400;

export function cleanInlineCompletion(raw: string, suffix: string): string {
  const noThink = raw
    .replace(/\r/g, "")
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/<\/think>/gi, "");
  const fence = /```[\w+-]*\s*\n([\s\S]*?)```/.exec(noThink);
  let text: string;
  if (fence?.[1] !== undefined) {
    text = fence[1].replace(/\s+$/, "");
  } else {
    // Drop leading blank lines + trailing whitespace, but preserve the
    // first line's indentation (ghost text inserts at the live cursor).
    text = noThink.replace(/^\n+/, "").replace(/\s+$/, "");
    if (text.length > MAX_RAW_INLINE_CHARS) return "";
    // Unfenced prose (explanations, thinking leftovers): a line with 6+
    // words ending in sentence punctuation is not code. Showing nothing
    // beats ghosting an explanation. (Fenced blocks skip this — the model
    // explicitly marked them as code.)
    if (/^\s*\S+(\s+\S+){5,}.*[.?!:]\s*$/m.test(text)) return "";
  }
  // Suffix echo: model repeated what comes after the cursor — cut it.
  const firstSuffixLine = suffix
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
    ?.slice(0, 60);
  if (firstSuffixLine) {
    const idx = text.indexOf(firstSuffixLine);
    if (idx !== -1) text = text.slice(0, idx).replace(/\s+$/, "");
  }
  return text;
}
