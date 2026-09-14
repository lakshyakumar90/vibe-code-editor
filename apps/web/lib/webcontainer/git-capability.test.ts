import { describe, expect, it } from "vitest";
import {
  parseGitVersion,
  shouldUseGitShim,
} from "./git-capability";

describe("parseGitVersion", () => {
  it("accepts real git --version output", () => {
    expect(parseGitVersion("git version 2.44.0\n")).toBe("git version 2.44.0");
  });

  it("rejects jsh command-not-found output", () => {
    expect(parseGitVersion("jsh: command not found: git\n")).toBeNull();
  });

  it("rejects empty output", () => {
    expect(parseGitVersion("")).toBeNull();
  });
});

describe("shouldUseGitShim", () => {
  it("uses the shim before the probe settles", () => {
    expect(shouldUseGitShim(null)).toBe(true);
  });

  it("uses the shim when native git is missing", () => {
    expect(
      shouldUseGitShim({ available: false, version: null }),
    ).toBe(true);
  });

  it("disables the shim when a future WebContainer ships native git", () => {
    expect(
      shouldUseGitShim({ available: true, version: "git version 2.44.0" }),
    ).toBe(false);
  });
});
