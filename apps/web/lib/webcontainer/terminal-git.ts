/**
 * Terminal `git` interception helpers (pure, unit-tested).
 *
 * The WebContainer shell (`jsh`) has no native `git` binary, so typing
 * `git ...` prints `jsh: command not found: git`. The terminal panel snoops
 * input lines; when a simple `git <args>` line is entered and the native
 * probe reports no git, it swallows that exact error line from the output
 * stream and runs the isomorphic-git shim instead. All other shell behavior
 * (echo, prompts, non-git commands) is untouched.
 */

 /**
 * Minimal shell-like splitter: whitespace-separated, honoring single and
 * double quotes (no escapes, no operators — one command only).
 * (Moved here from runtime.ts so tests can import it without the
 * WebContainer alias chain; runtime.ts re-exports it.)
 */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Shell metacharacters that disqualify a line from shim handling. */
const SHELL_META = /[|&;<>()$`!#\\]/;

/**
 * Parse a terminal input line. Returns shim argv (without the leading
 * "git") when the line is a simple `git ...` invocation, else null.
 * Quoting follows the same splitter as runtime commands.
 */
export function parseGitLine(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed !== "git" && !trimmed.startsWith("git ")) return null;
  const rest = trimmed === "git" ? "" : trimmed.slice(4);
  if (rest !== "" && SHELL_META.test(rest)) return null;
  if (trimmed === "git") return [];
  const argv = splitCommand(rest);
  for (const a of argv) {
    if (SHELL_META.test(a)) return null;
  }
  return argv;
}

/**
 * Commands whose shim execution can change workdir files and therefore
 * require a container→DB rescan afterwards.
 */
const MUTATING = new Set([
  "init",
  "checkout",
  "switch",
  "restore",
  "reset",
  "__ensure-snapshot",
]);

export function isMutatingGitCommand(argv: string[]): boolean {
  if (argv.length === 0) return false;
  return MUTATING.has(argv[0]!);
}

export interface TerminalGitEvent {
  projectId?: string;
  command: string;
  branchChanged: boolean;
  filesChanged: boolean;
  shouldRefreshGitState: boolean;
}

/** Build an explicit state payload from shim argv (no raw output as state). */
export function terminalGitEventFor(argv: string[]): Omit<TerminalGitEvent, "projectId"> {
  const command = argv[0] ?? "";
  const branchChanged = command === "switch" || command === "checkout" || command === "branch";
  const filesChanged =
    command === "checkout" ||
    command === "switch" ||
    command === "restore" ||
    command === "reset" ||
    command === "init";
  return {
    command,
    branchChanged,
    filesChanged,
    shouldRefreshGitState: branchChanged || filesChanged,
  };
}

export function isGitNotFoundLine(line: string): boolean {
  return /command not found:\s*git\b/.test(line);
}

/**
 * Stateful per-shell interceptor. Tracks input lines; when a simple
 * `git ...` line is entered while the shim is active, the next jsh
 * "command not found: git" output line is swallowed and the caller runs
 * the shim instead (see `fired`). Chunk-split error lines are handled by
 * buffering the trailing partial line while armed. Stale arms expire via
 * timeout (buffer flushed, no shim run).
 */
export class TerminalGitInterceptor {
  private lineBuf = "";
  /** FIFO: one entry per entered `git` line, consumed in order by errors. */
  private queue: { argv: string[]; armedAt: number }[] = [];
  /** Trailing overlap window for chunk-split error lines. Display is never held. */
  private tail = "";
  private busy = false;

  constructor(
    private readonly opts: {
      useShim: () => boolean;
      armTimeoutMs?: number;
    },
  ) {}

  /** Observe shell input bytes (still forwarded to the shell by the caller). */
  trackInput(data: string): void {
    for (const ch of data) {
      if (ch === "\x03" || ch === "\x15") {
        this.lineBuf = "";
        this.queue = [];
        this.tail = "";
      } else if (ch === "\x7f") {
        this.lineBuf = this.lineBuf.slice(0, -1);
      } else if (ch === "\r") {
        const argv = parseGitLine(this.lineBuf);
        this.lineBuf = "";
        // Fresh arm: drop stale output so a previous error can never
        // pre-fire this command.
        this.tail = "";
        if (argv !== null && this.opts.useShim()) {
          this.queue.push({ argv, armedAt: Date.now() });
        }
      } else if (ch >= " " || ch === "\t") {
        this.lineBuf += ch;
        if (this.lineBuf.length > 4000) {
          this.lineBuf = "";
          this.queue = [];
          this.tail = "";
        }
      }
    }
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /**
   * Filter one shell output chunk. Returns text to display (never held back)
   * and `fired` argv when jsh's not-found error was observed — the caller
   * must then run the shim exactly once for it. A chunk-split error line
   * still fires via the overlap window (its halves stay visible — rare,
   * cosmetic only); whole lines are swallowed.
   */
  filterOutput(chunk: string, now: number = Date.now()): { text: string; fired: string[] | null } {
    const timeout = this.opts.armTimeoutMs ?? 3000;
    while (this.queue.length > 0 && now - this.queue[0]!.armedAt > timeout) {
      this.queue.shift();
    }
    const head = this.queue[0] ?? null;
    if (!head || this.busy) {
      this.tail = (this.tail + chunk).slice(-120);
      return { text: chunk, fired: null };
    }
    const fired = isGitNotFoundLine(this.tail + chunk) ? head.argv : null;
    this.tail = (this.tail + chunk).slice(-120);
    if (fired === null) return { text: chunk, fired: null };
    this.queue.shift();
    this.tail = "";
    const { text } = filterNotFoundOutput(chunk);
    return { text, fired };
  }
}

/**
 * Strip jsh `command not found: git` lines from a shell output chunk.
 * Returns the filtered chunk and whether anything was swallowed.
 */
export function filterNotFoundOutput(chunk: string): { text: string; swallowed: boolean } {
  const lines = chunk.split("\n");
  const kept = lines.filter((l) => !isGitNotFoundLine(l));
  return { text: kept.join("\n"), swallowed: kept.length !== lines.length };
}
