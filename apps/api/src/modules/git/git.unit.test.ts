import { describe, expect, it } from "vitest";
import { GitError } from "./git.errors";
import {
  isCommitSha,
  normalizeBranchName,
  normalizeGitPath,
  normalizeGitPathList,
  resolveWorktreePath,
} from "./git.paths";
import { clearGitLocks, isGitLocked, withProjectGitLock } from "./git.lock";
import { removeWorktreeDir, worktreeDirFor } from "./git.store";
import { commitIdentityFor } from "./git.service";

describe("normalizeGitPath", () => {
  it("accepts normal repo-relative paths", () => {
    expect(normalizeGitPath("src/App.tsx")).toBe("src/App.tsx");
    expect(normalizeGitPath("a/./b")).toBe("a/b");
    expect(normalizeGitPath("README.md")).toBe("README.md");
  });

  it("rejects traversal, absolute, windows, and hostile inputs", () => {
    for (const bad of [
      "../foo",
      "a/../../etc/passwd",
      "..",
      ".",
      "",
      "/etc/passwd",
      "C:\\Windows\\x",
      "C:/x",
      "\\\\server\\share",
      "a\\b",
      "a\0b",
      "--upload-pack=x",
      "src/--flag",
      "-evil.txt",
    ]) {
      expect(() => normalizeGitPath(bad), bad).toThrow(GitError);
    }
  });

  it("collapses harmless dot segments without escaping", () => {
    expect(normalizeGitPath("a//../b")).toBe("b");
  });

  it("dedupes path lists and rejects non-arrays", () => {
    expect(normalizeGitPathList(["a.ts", "a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
    expect(() => normalizeGitPathList("a.ts")).toThrow(GitError);
  });
});

describe("resolveWorktreePath", () => {
  it("jails resolved paths under the worktree root", () => {
    const root = process.platform === "win32" ? "C:\\wt" : "/wt";
    const resolved = resolveWorktreePath(root, "src/a.ts");
    expect(resolved.endsWith(`src${require("node:path").sep}a.ts`)).toBe(true);
    expect(() => resolveWorktreePath(root, "../escape")).toThrow(GitError);
  });
});

describe("normalizeBranchName / isCommitSha", () => {
  it("accepts sane branches, rejects flag-like and traversal names", () => {
    expect(normalizeBranchName("main")).toBe("main");
    expect(normalizeBranchName("feature/x-1.0")).toBe("feature/x-1.0");
    for (const bad of ["", "../x", "-b trick", "a..b", "x y", "--help"]) {
      expect(() => normalizeBranchName(bad), String(bad)).toThrow(GitError);
    }
  });

  it("never confuses branch names with SHAs", () => {
    expect(isCommitSha("a".repeat(40))).toBe(true);
    expect(isCommitSha("main")).toBe(false);
    expect(isCommitSha("abc123")).toBe(false);
    expect(isCommitSha("")).toBe(false);
    expect(isCommitSha(null)).toBe(false);
  });
});

describe("worktree store jail", () => {
  it("derives locations from ids only and refuses hostile input", () => {
    const dir = worktreeDirFor("abc123");
    expect(dir.endsWith("abc123")).toBe(true);
    for (const bad of ["../x", "a/b", "", "a b", "x".repeat(200), "a;b", ".."]) {
      expect(() => worktreeDirFor(bad), String(bad)).toThrow(GitError);
    }
  });

  it("removeWorktreeDir refuses paths outside the storage root", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\Temp\\x" : "/tmp/x";
    await expect(removeWorktreeDir(outside)).rejects.toBeInstanceOf(GitError);
  });
});

describe("withProjectGitLock", () => {
  it("serializes one op and 409s the other", async () => {
    clearGitLocks();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withProjectGitLock("p1", "stage", () => gate.then(() => "first"));
    expect(isGitLocked("p1")).toBe(true);
    await expect(withProjectGitLock("p1", "commit", async () => "second")).rejects.toMatchObject({
      code: "GIT_OPERATION_IN_PROGRESS",
    });
    release();
    await expect(first).resolves.toBe("first");
    expect(isGitLocked("p1")).toBe(false);
    // Lock releases even on failure.
    await expect(
      withProjectGitLock("p1", "boom", async () => {
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
    expect(isGitLocked("p1")).toBe(false);
    // Independent projects do not contend.
    await expect(withProjectGitLock("p2", "x", async () => 1)).resolves.toBe(1);
  });
});

describe("commitIdentityFor", () => {
  it("uses sanitized user name/email", () => {
    expect(commitIdentityFor({ id: "u1", name: "Ravi", email: "ravi@example.com" })).toEqual({
      name: "Ravi",
      email: "ravi@example.com",
    });
  });

  it("strips control characters and falls back deterministically", () => {
    const id = commitIdentityFor({ id: "abc123", name: "Evil\nName<>\"", email: "not-an-email" });
    expect(id.name).toBe("EvilName");
    expect(id.email).toBe("user-abc123@vibe.local");
    expect(commitIdentityFor({ id: "abc123", name: "", email: null }).name).toBe("User");
  });
});
