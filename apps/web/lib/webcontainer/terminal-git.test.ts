import { describe, expect, it } from "vitest";
import {
  filterNotFoundOutput,
  isGitNotFoundLine,
  isMutatingGitCommand,
  parseGitLine,
  TerminalGitInterceptor,
} from "./terminal-git";

describe("parseGitLine", () => {
  it("parses simple git invocations", () => {
    expect(parseGitLine("git status")).toEqual(["status"]);
    expect(parseGitLine("  git commit -m \"hello world\"  ")).toEqual([
      "commit",
      "-m",
      "hello world",
    ]);
    expect(parseGitLine("git")).toEqual([]);
  });

  it("rejects non-git lines", () => {
    expect(parseGitLine("npm run dev")).toBeNull();
    expect(parseGitLine("gitlab")).toBeNull();
    expect(parseGitLine("")).toBeNull();
  });

  it("rejects shell operators (passed through to jsh)", () => {
    expect(parseGitLine("git log | head")).toBeNull();
    expect(parseGitLine("git status && npm test")).toBeNull();
    expect(parseGitLine("git commit -m $(evil)")).toBeNull();
    expect(parseGitLine("FOO=1 git status")).toBeNull();
  });
});

describe("isMutatingGitCommand", () => {
  it("flags workdir-changing commands", () => {
    expect(isMutatingGitCommand(["checkout", "main"])).toBe(true);
    expect(isMutatingGitCommand(["restore", "a.ts"])).toBe(true);
    expect(isMutatingGitCommand(["reset", "--hard"])).toBe(true);
    expect(isMutatingGitCommand(["switch", "x"])).toBe(true);
    expect(isMutatingGitCommand(["init"])).toBe(true);
  });

  it("ignores read-only commands", () => {
    expect(isMutatingGitCommand(["status"])).toBe(false);
    expect(isMutatingGitCommand(["log"])).toBe(false);
    expect(isMutatingGitCommand(["commit", "-m", "x"])).toBe(false);
    expect(isMutatingGitCommand([])).toBe(false);
  });
});

describe("not-found output filter", () => {
  it("detects jsh's missing git error", () => {
    expect(isGitNotFoundLine("jsh: command not found: git")).toBe(true);
    expect(isGitNotFoundLine("npm run dev")).toBe(false);
  });

  it("swallows only the error line", () => {
    const { text, swallowed } = filterNotFoundOutput(
      "echo hi\njsh: command not found: git\n~/project ❯ ",
    );
    expect(swallowed).toBe(true);
    expect(text).toBe("echo hi\n~/project ❯ ");
  });
});

describe("TerminalGitInterceptor session", () => {
  function tapKeys(g: TerminalGitInterceptor, line: string): void {
    g.trackInput(line + "\r");
  }

  it("fires once on the error line and swallows it", () => {
    const g = new TerminalGitInterceptor({ useShim: () => true });
    tapKeys(g, "git status");
    // jsh echo has no error: passes through, no fire.
    expect(g.filterOutput("git status\r\n")).toEqual({ text: "git status\r\n", fired: null });
    const r = g.filterOutput("jsh: command not found: git\r\n~/project ❯ ");
    expect(r.fired).toEqual(["status"]);
    expect(r.text).toBe("~/project ❯ ");
    // Second error with empty queue: displayed, no fire.
    expect(g.filterOutput("jsh: command not found: git\r\n").fired).toBeNull();
  });

  it("passes non-git lines through without arming", () => {
    const g = new TerminalGitInterceptor({ useShim: () => true });
    tapKeys(g, "npm run dev");
    const r = g.filterOutput("jsh: command not found: git\r\n");
    expect(r.fired).toBeNull();
    expect(r.text).toContain("command not found");
  });

  it("stays idle when native git exists", () => {
    const g = new TerminalGitInterceptor({ useShim: () => false });
    tapKeys(g, "git status");
    expect(g.filterOutput("jsh: command not found: git\r\n").fired).toBeNull();
  });

  it("fires across a chunk-split error line", () => {
    const g = new TerminalGitInterceptor({ useShim: () => true });
    tapKeys(g, "git log");
    expect(g.filterOutput("jsh: command not").fired).toBeNull();
    const r = g.filterOutput(" found: git\r\n");
    expect(r.fired).toEqual(["log"]);
  });

  it("expires stale arms without firing", () => {
    const g = new TerminalGitInterceptor({ useShim: () => true, armTimeoutMs: 100 });
    tapKeys(g, "git status");
    const r = g.filterOutput("jsh: command not found: git\r\n", Date.now() + 5000);
    expect(r.fired).toBeNull();
    expect(r.text).toContain("command not found");
  });

  it("pairs pasted commands in order", () => {
    const g = new TerminalGitInterceptor({ useShim: () => true });
    g.trackInput("git status\rgit log\r");
    expect(g.filterOutput("jsh: command not found: git\r\n").fired).toEqual(["status"]);
    expect(g.filterOutput("jsh: command not found: git\r\n").fired).toEqual(["log"]);
  });

  it("suppresses firing while a shim run is in flight", () => {
    const g = new TerminalGitInterceptor({ useShim: () => true });
    tapKeys(g, "git status");
    g.setBusy(true);
    const r = g.filterOutput("jsh: command not found: git\r\n");
    expect(r.fired).toBeNull();
    expect(r.text).toContain("command not found");
  });

  it("Ctrl+C clears a pending arm", () => {
    const g = new TerminalGitInterceptor({ useShim: () => true });
    tapKeys(g, "git status");
    g.trackInput("\x03");
    expect(g.filterOutput("jsh: command not found: git\r\n").fired).toBeNull();
  });
});
