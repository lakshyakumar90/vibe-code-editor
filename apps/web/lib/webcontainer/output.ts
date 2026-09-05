/**
 * dev-server / npm output is written for a TTY: ANSI colors, cursor moves,
 * `\r` progress rewrites (spinners). The Output panel is plain text, so
 * clean chunks before storing them.
 */

// Built from char codes to keep control characters out of the source.
const ESC = String.fromCharCode(27);
const CSI = String.fromCharCode(155);

const ANSI_PATTERN = new RegExp(
  "[" + ESC + CSI + "][[()\\][#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-ORZcf-nqry=><~]",
  "g",
);

/** Max characters kept for the whole log buffer. */
export const LOG_CHAR_LIMIT = 30_000;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
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

export function cleanProcessOutput(input: string): string {
  return collapseCarriageReturns(stripAnsi(input));
}

/** Append a cleaned chunk, keeping the buffer within LOG_CHAR_LIMIT. */
export function appendCleanedLog(prev: string[], chunk: string): string[] {
  const cleaned = cleanProcessOutput(chunk);
  if (!cleaned) return prev;
  const next = [...prev, cleaned];
  let total = next.reduce((sum, s) => sum + s.length, 0);
  while (next.length > 1 && total > LOG_CHAR_LIMIT) {
    const removed = next.shift()!;
    total -= removed.length;
  }
  return next;
}
