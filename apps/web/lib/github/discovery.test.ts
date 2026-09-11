import { describe, expect, it } from "vitest";
import {
  accessLabel,
  canContinue,
  detectionExplainer,
  detectionLabel,
  filterByTab,
  resolveImportRoot,
  tabCounts,
  templateDisplayName,
  type InspectionState,
} from "./discovery";
import type { GitHubRepo } from "@/lib/services/github";

/**
 * Phase 2 — frontend helper tests (28–33 at the logic level; components
 * are thin renderers over these pure functions).
 */

function repo(fullName: string, access = { canWrite: true }): GitHubRepo {
  const [owner, name] = fullName.split("/");
  return {
    id: fullName,
    name: name!,
    fullName,
    owner: { login: owner!, type: "User" },
    private: false,
    fork: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${fullName}`,
    description: null,
    language: "TypeScript",
    stars: 0,
    updatedAt: null,
    permissions: { pull: true, push: access.canWrite, admin: false, maintain: false, triage: false },
    access: { canRead: true, canWrite: access.canWrite, canAdmin: false },
  };
}

function ready(kind: "supported" | "ambiguous" | "unsupported", truncated = false): InspectionState {
  if (kind === "supported") {
    return {
      state: "ready",
      inspection: {
        owner: "o",
        repo: "r",
        fullName: "o/r",
        defaultBranch: "main",
        sha: "s",
        truncated,
        treeCount: 3,
        roots: [],
        detection: { kind: "supported", template: "NEXTJS", root: "", confidence: 0.9, reasons: [] },
      },
    };
  }
  if (kind === "ambiguous") {
    return {
      state: "ready",
      inspection: {
        owner: "o",
        repo: "r",
        fullName: "o/r",
        defaultBranch: "main",
        sha: "s",
        truncated,
        treeCount: 5,
        roots: [],
        detection: {
          kind: "ambiguous",
          candidates: [
            { template: "NEXTJS", root: "apps/web" },
            { template: "EXPRESS", root: "apps/api" },
          ],
          reasons: [],
        },
      },
    };
  }
  return {
    state: "ready",
    inspection: {
      owner: "o",
      repo: "r",
      fullName: "o/r",
      defaultBranch: "main",
      sha: "s",
      truncated,
      treeCount: 2,
      roots: [],
      detection: { kind: "unsupported", reasons: [], truncated: truncated || undefined },
    },
  };
}

describe("import discovery helpers", () => {
  const repos = [repo("o/next-app"), repo("o/mono"), repo("o/py-api"), repo("o/unchecked")];
  const inspections: Record<string, InspectionState> = {
    "o/next-app": ready("supported"),
    "o/mono": ready("ambiguous"),
    "o/py-api": ready("unsupported"),
  };

  it("30. supported repo displays its canonical template name", () => {
    expect(detectionLabel(ready("supported"))).toBe("Next.js");
    expect(templateDisplayName("NEXTJS")).toBe("Next.js");
  });

  it("tabs filter by detection state; unclassified stay under All", () => {
    expect(filterByTab(repos, inspections, "all")).toHaveLength(4);
    expect(filterByTab(repos, inspections, "supported").map((r) => r.fullName)).toEqual(["o/next-app"]);
    expect(filterByTab(repos, inspections, "ambiguous").map((r) => r.fullName)).toEqual(["o/mono"]);
    expect(filterByTab(repos, inspections, "unsupported").map((r) => r.fullName)).toEqual(["o/py-api"]);
  });

  it("tab counts ignore pending inspections except in All", () => {
    expect(tabCounts(repos, inspections)).toEqual({ all: 4, supported: 1, ambiguous: 1, unsupported: 1 });
  });

  it("31. unsupported repo cannot continue; supported can", () => {
    expect(canContinue(ready("unsupported"))).toBe(false);
    expect(canContinue(ready("ambiguous"))).toBe(false);
    expect(canContinue(ready("supported"))).toBe(true);
    expect(canContinue({ state: "checking" })).toBe(false);
    expect(canContinue({ state: "error", message: "x" })).toBe(false);
  });

  it("32. ambiguous repo surfaces a multi-app label", () => {
    expect(detectionLabel(ready("ambiguous"))).toBe("Multiple apps detected");
  });

  it("truncated inspection shows a too-large label and cannot continue", () => {
    const t = ready("unsupported", true);
    expect(detectionLabel(t)).toBe("Too large to inspect");
    expect(canContinue(t)).toBe(false);
  });

  it("access label reflects visibility + write permission (never IDE roles)", () => {
    expect(accessLabel(repo("o/a", { canWrite: true }))).toBe("public · Write access");
    const priv = { ...repo("o/b", { canWrite: false }), private: true };
    expect(accessLabel(priv)).toBe("private · Read access");
  });

  it("pending/error states label safely", () => {
    expect(detectionLabel({ state: "pending" })).toBe("Checking compatibility…");
    expect(detectionLabel({ state: "error", message: "boom" })).toBe("Check failed");
  });

  it("supported detection resolves its own root; others stay disabled", () => {
    expect(resolveImportRoot(ready("supported"), null)).toBe("");
    expect(resolveImportRoot(ready("unsupported"), null)).toBeNull();
    expect(resolveImportRoot({ state: "checking" }, null)).toBeNull();
    expect(resolveImportRoot({ state: "error", message: "x" }, null)).toBeNull();
  });

  it("monorepo requires a valid chosen candidate root", () => {
    const mono = ready("ambiguous");
    expect(resolveImportRoot(mono, null)).toBeNull();
    expect(resolveImportRoot(mono, "apps/web")).toBe("apps/web");
    expect(resolveImportRoot(mono, "apps/api")).toBe("apps/api");
    expect(resolveImportRoot(mono, "../../etc")).toBeNull();
    expect(resolveImportRoot(mono, "/")).toBeNull();
  });

  it("explainers distinguish genuine-unsupported from too-large states", () => {
    const genuine = detectionExplainer(ready("unsupported"));
    expect(genuine).toContain("Unsupported repository");
    expect(genuine).toContain("No supported project template was detected");
    const tooLarge = detectionExplainer(ready("unsupported", true));
    expect(tooLarge).toContain("Unable to safely inspect");
    expect(tooLarge).toContain("does not necessarily mean the repository is unsupported");
    expect(tooLarge).not.toContain("No supported project template was detected");
    expect(detectionExplainer(ready("supported"))).toBeNull();
    expect(detectionExplainer(ready("ambiguous"))).toBeNull();
    expect(detectionExplainer({ state: "pending" })).toBeNull();
  });
});
