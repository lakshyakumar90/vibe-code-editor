import { describe, expect, it } from "vitest";
import {
  commitMessageError,
  displayPath,
  groupStatusEntries,
  panelState,
  statusBadge,
  statusCounts,
} from "./helpers";
import type { GitStatus } from "./service";

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    clean: false,
    truncated: false,
    totalCount: 2,
    entries: [
      { path: "a.ts", status: "modified", staged: true, unstaged: true },
      { path: "b.ts", status: "untracked", staged: false, unstaged: true },
    ],
    ...overrides,
  };
}

describe("source control helpers", () => {
  it("badges are deterministic single letters (never color-only)", () => {
    expect(statusBadge("modified")).toBe("M");
    expect(statusBadge("added")).toBe("A");
    expect(statusBadge("deleted")).toBe("D");
    expect(statusBadge("renamed")).toBe("R");
    expect(statusBadge("untracked")).toBe("?");
    expect(statusBadge("conflicted")).toBe("!");
    expect(statusBadge("copied")).toBe("C");
  });

  it("renames display old → new paths", () => {
    expect(
      displayPath({ path: "new.ts", oldPath: "old.ts", status: "renamed", staged: true, unstaged: false }),
    ).toBe("old.ts → new.ts");
    expect(displayPath({ path: "a.ts", status: "modified", staged: false, unstaged: true })).toBe("a.ts");
  });

  it("splits staged vs unstaged; dual-dirty entries appear in both", () => {
    const groups = groupStatusEntries(status());
    expect(groups.staged.map((e) => e.path)).toEqual(["a.ts"]);
    expect(groups.unstaged.map((e) => e.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("handles null status and counts", () => {
    expect(groupStatusEntries(null)).toEqual({ staged: [], unstaged: [] });
    expect(statusCounts(status())).toEqual({ staged: 1, unstaged: 2, total: 2 });
  });

  it("validates commit messages like the server", () => {
    expect(commitMessageError("")).toBe("Enter a commit message");
    expect(commitMessageError("   ")).toBe("Enter a commit message");
    expect(commitMessageError("x".repeat(2001))).toContain("2000");
    expect(commitMessageError("feat: ok")).toBeNull();
  });

  it("resolves panel states in priority order", () => {
    const base = { notConnected: false, initializing: false, error: null as string | null, status: null as GitStatus | null };
    expect(panelState({ ...base, loading: true })).toBe("loading");
    expect(panelState({ ...base, loading: false, notConnected: true })).toBe("not-connected");
    expect(panelState({ ...base, loading: false, initializing: true })).toBe("initializing");
    expect(panelState({ ...base, loading: false, error: "boom" })).toBe("error");
    expect(panelState({ ...base, loading: false })).toBe("clean");
    expect(
      panelState({ ...base, loading: false, status: status() }),
    ).toBe("changes");
    expect(
      panelState({
        ...base,
        loading: false,
        status: { branch: "main", clean: true, truncated: false, totalCount: 0, entries: [] },
      }),
    ).toBe("clean");
  });
});
