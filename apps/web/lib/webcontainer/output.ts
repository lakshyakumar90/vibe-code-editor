/**
 * dev-server / npm output is written for a TTY: ANSI colors, cursor moves,
 * `\r` progress rewrites (spinners). The Output panel is plain text, so
 * clean chunks before storing them.
 */

// Built from char codes to keep control characters out of the source.
const ESC = String.fromCharCode(27);
const CSI = String.fromCharCode(155);
const BEL = String.fromCharCode(7);

const ANSI_PATTERN = new RegExp(
  "[" + ESC + CSI + "][[()\\][#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-ORZcf-nqry=><~]",
  "g",
);

// OSC sequences (window title, hyperlinks, …) are BEL- or ESC\-terminated
// and are NOT matched by ANSI_PATTERN — without this they leak text like
// `8;;http://…` into the scrollback.
const OSC_PATTERN = new RegExp(
  ESC + "\\][^" + BEL + "]*?(?:" + BEL + "|" + ESC + "\\\\)",
  "g",
);

/** Max characters kept for the whole log buffer. */
export const LOG_CHAR_LIMIT = 30_000;

export function stripAnsi(input: string): string {
  return input.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}

/**
 * Collapse TTY line-rewrites: a lone `\r` returns the cursor to column 0,
 * so only the last segment of each `\r`-separated line is visible on a
 * real terminal. Keep that segment; drop spinner noise.
 */
export function collapseCarriageReturns(input: string): string {
  return input
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r").filter((s) => s.length > 0);
      return segments.length > 0 ? segments[segments.length - 1]! : "";
    })
    .join("\n");
}

/**
 * Erase-in-line (`EL`: `ESC[K`, `ESC[0K`, `ESC[1K`, `ESC[2K`) and
 * cursor-column (`ESC[nG`) sequences mean "discard what was drawn on this
 * line" — e.g. npm emits `\x1b[2K` before rewriting progress. Map them to
 * `\r` FIRST so the collapse step below drops the stale segment instead
 * of gluing it onto the next text (`-9 packages…`, `\added…` artifacts).
 * Erase-in-display (`ESC[J` variants) carries no text — drop it.
 */
const EL_PATTERN = new RegExp(ESC + "\\[(?:[12]?K|[0-9]*G)", "g");
const ED_PATTERN = new RegExp(ESC + "\\[[012]?J", "g");

export function cleanProcessOutput(input: string): string {
  const withErasesApplied = input
    .replace(EL_PATTERN, "\r")
    .replace(ED_PATTERN, "");
  return collapseCarriageReturns(stripAnsi(withErasesApplied));
}

/**
 * Append a cleaned chunk, keeping the buffer within LOG_CHAR_LIMIT.
 *
 * TTY rewrites (spinners, progress bars) emit `\r`-separated frames that
 * arrive SPLIT across stream chunks — cleaning each chunk in isolation
 * leaves every frame visible (`|/-\|/-\…`). So each chunk is merged with
 * the pending tail line BEFORE cleaning; only newline-terminated lines
 * become frozen entries, the trailing partial line stays mergeable.
 * Complete lines keep their trailing `\n` so terminal feeds preserve
 * line breaks. Runs of 3+ blank lines (progress-clear spam) are squeezed
 * down to 2.
 */
export function appendCleanedLog(prev: string[], chunk: string): string[] {
  if (!chunk) return prev;
  const head = prev.slice(0, -1);
  const tail = prev.length > 0 ? prev[prev.length - 1]! : "";
  const cleaned = cleanProcessOutput(tail + chunk);
  const trailingNewline = cleaned.endsWith("\n");
  const lines = cleaned.split("\n");
  const complete = lines.slice(0, -1);
  const nextTail = trailingNewline ? "" : (lines[lines.length - 1] ?? "");
  const next: string[] = [...head];
  for (const line of complete) {
    if (line.trim() === "") {
      const n = next.length;
      const blank = (i: number) =>
        i >= 0 && next[i]!.replace(/\n/g, "").trim() === "";
      if (blank(n - 1) && blank(n - 2)) continue;
    }
    next.push(line + "\n");
  }
  if (!trailingNewline) next.push(nextTail);
  let total = 0;
  for (const s of next) total += s.length;
  while (next.length > 1 && total > LOG_CHAR_LIMIT) {
    total -= next.shift()!.length;
  }
  return next;
}
