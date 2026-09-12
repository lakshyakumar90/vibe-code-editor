import { describe, expect, it } from "vitest";
import {
  aheadBehindLabel,
  branchNameError,
  capabilityCopy,
  commitMessageError,
  displayPath,
  formatCommitTime,
  groupStatusEntries,
  panelState,
  statusBadge,
  statusCounts,
} from "./helpers";
import type { GitStatus } from "./service";

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: false,
    truncated: false,
    totalCount: 2,
    entries: [
      { path: "a.ts", status: "modified", staged: true, unstaged: true },
      { path: "b.ts", status: "untracked", staged: false, unstaged: true },
    ],
    remote: null,
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
        status: {
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          clean: true,
          truncated: false,
          totalCount: 0,
          entries: [],
          remote: null,
        },
      }),
    ).toBe("clean");
  });

  it("formats ahead/behind compactly, null when in sync", () => {
    expect(aheadBehindLabel(0, 0)).toBeNull();
    expect(aheadBehindLabel(2, 0)).toBe("↑2");
    expect(aheadBehindLabel(0, 3)).toBe("↓3");
    expect(aheadBehindLabel(2, 3)).toBe("↑2 ↓3");
  });

  it("describes capabilities without implying unavailable push", () => {
    expect(capabilityCopy("LOCAL_ONLY")).toMatchObject({
      pushAvailable: false,
      remoteActions: false,
    });
    expect(capabilityCopy("LOCAL_ONLY").remoteLine).toContain("Local Git");
    expect(capabilityCopy("CONNECTED_READONLY").pushAvailable).toBe(false);
    expect(capabilityCopy("CONNECTED_READONLY").remoteActions).toBe(true);
    expect(capabilityCopy("CONNECTED_READONLY").remoteLine).toContain("write permission");
    expect(capabilityCopy("CONNECTED_WRITE")).toMatchObject({
      pushAvailable: true,
      remoteActions: true,
    });
    expect(capabilityCopy("REMOTE_UNAVAILABLE").remoteLine).toContain("unavailable");
    expect(capabilityCopy("REAUTH_REQUIRED").remoteLine).toContain("expired");
  });

  it("mirrors server branch-name rules for instant feedback", () => {
    expect(branchNameError("")).toBe("Enter a branch name");
    expect(branchNameError("feature/auth")).toBeNull();
    for (const bad of ["../main", "../../foo", "refs/heads/x", "-control", "foo..bar", "foo@", "HEAD", "a b"]) {
      expect(branchNameError(bad), bad).not.toBeNull();
    }
  });

  it("formats commit times relatively", () => {
    const now = Date.parse("2026-09-12T12:00:00Z");
    expect(formatCommitTime("2026-09-12T11:59:30Z", now)).toBe("just now");
    expect(formatCommitTime("2026-09-12T11:58:00Z", now)).toBe("2 min ago");
    expect(formatCommitTime("2026-09-12T10:00:00Z", now)).toBe("2 hours ago");
    expect(formatCommitTime("2026-09-10T12:00:00Z", now)).toBe("2 days ago");
    expect(formatCommitTime("not-a-date", now)).toBe("not-a-date");
  });
});
