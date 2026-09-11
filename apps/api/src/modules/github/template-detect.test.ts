import { describe, expect, it } from "vitest";
import { getTemplateFiles } from "@repo/templates";
import {
  detectAppRoot,
  detectRepository,
  findAppRoots,
  scopeFilesToRoot,
  type AppRootInspection,
  type InspectionPackageJson,
} from "@repo/templates/detect";

/**
 * Phase 2 — detector tests. Canonical cases (1–6) are derived from the
 * actual curated templates via getTemplateFiles, so the detector is tested
 * against the single source of truth, not hand copies.
 */

function canonicalInspection(id: "NEXTJS" | "EXPRESS" | "HONO" | "REACT" | "ANGULAR" | "VUE"): AppRootInspection {
  const files = getTemplateFiles(id);
  const pkgFile = files.find((f) => f.path === "package.json");
  if (!pkgFile) throw new Error(`canonical ${id} has no package.json`);
  const packageJson = JSON.parse(pkgFile.content) as InspectionPackageJson;
  return { root: "", files: files.map((f) => f.path), packageJson };
}

function root(pkg: InspectionPackageJson, files: string[] = [], root = ""): AppRootInspection {
  return { root, files, packageJson: pkg };
}

const pkg = (
  dependencies: Record<string, string> = {},
  extra: Partial<InspectionPackageJson> = {},
): InspectionPackageJson => ({ dependencies, ...extra });

describe("canonical templates", () => {
  it("1. canonical Next.js template → NEXTJS", () => {
    const r = detectAppRoot(canonicalInspection("NEXTJS"));
    expect(r.kind).toBe("supported");
    if (r.kind === "supported") expect(r.template).toBe("NEXTJS");
  });
  it("2. canonical Express template → EXPRESS", () => {
    const r = detectAppRoot(canonicalInspection("EXPRESS"));
    expect(r.kind).toBe("supported");
    if (r.kind === "supported") expect(r.template).toBe("EXPRESS");
  });
  it("3. canonical Hono template → HONO", () => {
    const r = detectAppRoot(canonicalInspection("HONO"));
    expect(r.kind).toBe("supported");
    if (r.kind === "supported") expect(r.template).toBe("HONO");
  });
  it("4. canonical React template → REACT", () => {
    const r = detectAppRoot(canonicalInspection("REACT"));
    expect(r.kind).toBe("supported");
    if (r.kind === "supported") expect(r.template).toBe("REACT");
  });
  it("5. canonical Angular template → ANGULAR", () => {
    const r = detectAppRoot(canonicalInspection("ANGULAR"));
    expect(r.kind).toBe("supported");
    if (r.kind === "supported") expect(r.template).toBe("ANGULAR");
  });
  it("6. canonical Vue template → VUE", () => {
    const r = detectAppRoot(canonicalInspection("VUE"));
    expect(r.kind).toBe("supported");
    if (r.kind === "supported") expect(r.template).toBe("VUE");
  });
});

describe("disambiguation rules", () => {
  it("7. Next.js (with react) classifies as NEXTJS, not plain React", () => {
    const r = detectAppRoot(
      root(pkg({ next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" }), ["app/page.tsx", "next.config.mjs"]),
    );
    expect(r).toMatchObject({ kind: "supported", template: "NEXTJS" });
  });

  it("8. Nuxt is rejected even though it depends on vue", () => {
    const r = detectAppRoot(
      root(pkg({ vue: "^3.4.0", nuxt: "^3.10.0" }), ["app.vue", "nuxt.config.ts"]),
    );
    expect(r.kind).toBe("unsupported");
    if (r.kind === "unsupported") expect(r.reasons.join(" ")).toMatch(/nuxt/i);
  });

  it("9. Express does not classify as Hono; both together are ambiguous", () => {
    const expressOnly = detectAppRoot(root(pkg({ express: "^4.18.2" }), ["index.js"]));
    expect(expressOnly).toMatchObject({ kind: "supported", template: "EXPRESS" });
    const both = detectAppRoot(root(pkg({ express: "^4.0.0", hono: "^4.0.0" }), ["index.js", "src/index.ts"]));
    expect(both.kind).toBe("ambiguous");
    if (both.kind === "ambiguous") {
      expect(both.candidates.map((c) => c.template).sort()).toEqual(["EXPRESS", "HONO"]);
    }
  });

  it("10. Angular requires angular.json, not just @angular/core", () => {
    const bare = detectAppRoot(root(pkg({ "@angular/core": "^21.0.0" }), ["src/main.ts"]));
    expect(bare.kind).toBe("unsupported");
    const full = detectAppRoot(
      root(pkg({ "@angular/core": "^21.0.0" }), ["angular.json", "src/main.ts"]),
    );
    expect(full).toMatchObject({ kind: "supported", template: "ANGULAR" });
  });

  it("11. unsupported Python repository → UNSUPPORTED", () => {
    const r = detectRepository({
      truncated: false,
      roots: [{ root: "", files: ["app.py", "requirements.txt", "README.md"], packageJson: null }],
    });
    expect(r.kind).toBe("unsupported");
  });

  it("12. no package.json → UNSUPPORTED", () => {
    const r = detectRepository({ truncated: false, roots: [] });
    expect(r.kind).toBe("unsupported");
    const r2 = detectAppRoot({ root: "", files: ["index.html"], packageJson: null });
    expect(r2.kind).toBe("unsupported");
  });
});

describe("monorepo / multi-app policy", () => {
  const nextRoot = root(
    pkg({ next: "13.5.1", react: "18.2.0" }),
    ["package.json", "app/page.tsx", "next.config.js"],
    "apps/web",
  );
  const expressRoot = root(
    pkg({ express: "^4.18.2" }),
    ["package.json", "index.js"],
    "apps/api",
  );

  it("13. monorepo with Next + Express → AMBIGUOUS with per-root candidates", () => {
    const r = detectRepository({ truncated: false, roots: [nextRoot, expressRoot] });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates).toContainEqual({ template: "NEXTJS", root: "apps/web" });
      expect(r.candidates).toContainEqual({ template: "EXPRESS", root: "apps/api" });
    }
  });

  it("14. multiple supported apps (same template twice) → AMBIGUOUS, never silent choice", () => {
    const a = root(pkg({ react: "^18.0.0", vite: "^5.0.0" }), ["package.json", "src/main.tsx"], "packages/a");
    const b = root(pkg({ react: "^18.0.0", vite: "^5.0.0" }), ["package.json", "src/main.tsx"], "packages/b");
    const r = detectRepository({ truncated: false, roots: [a, b] });
    expect(r.kind).toBe("ambiguous");
  });

  it("single supported app plus unrelated noise stays SUPPORTED with a note", () => {
    const docs = root(pkg({}), ["package.json", "README.md"], "docs");
    const r = detectRepository({ truncated: false, roots: [nextRoot, docs] });
    expect(r).toMatchObject({ kind: "supported", template: "NEXTJS" });
    if (r.kind === "supported") expect(r.reasons.join(" ")).toMatch(/dominant/i);
  });
});

describe("robustness", () => {
  it("15. versions are ignored (odd ranges, canary, git URLs)", () => {
    const r = detectAppRoot(
      root(pkg({ next: "canary", react: "*", "react-dom": "github:facebook/react" }), ["app/page.tsx"]),
    );
    expect(r).toMatchObject({ kind: "supported", template: "NEXTJS" });
  });

  it("16. unsupported dependency noise does not break a clearly supported app", () => {
    const r = detectAppRoot(
      root(
        pkg({ react: "^18.0.0", vite: "^5.0.0", "some-obscure-tool": "^1.0.0", leftpad: "^9.9.9" }),
        ["src/main.tsx", "index.html", "weird-custom-file.xyz"],
      ),
    );
    expect(r).toMatchObject({ kind: "supported", template: "REACT" });
  });

  it("truncated inspection never yields SUPPORTED", () => {
    const r = detectRepository({ truncated: true, roots: [canonicalAsRoot()] });
    expect(r.kind).toBe("unsupported");
    expect(r.truncated).toBe(true);
    if (r.kind === "unsupported") expect(r.reasons.join(" ")).toMatch(/truncated|incomplete/i);
  });
});

function canonicalAsRoot(): AppRootInspection {
  return canonicalInspection("NEXTJS");
}

describe("findAppRoots / scopeFilesToRoot", () => {
  it("discovers repo-root and nested roots up to depth 3, skipping generated dirs", () => {
    const roots = findAppRoots([
      "package.json",
      "apps/web/package.json",
      "apps/api/package.json",
      "a/b/c/package.json",
      "a/b/c/d/package.json",
      "node_modules/foo/package.json",
      "apps/web/dist/package.json",
    ]);
    expect(roots).toEqual(["", "a/b/c", "apps/api", "apps/web"]);
  });

  it("scopes files per root without leaking sibling app files into repo root", () => {
    const tree = ["package.json", "next.config.js", "apps/web/package.json", "apps/web/app/page.tsx"];
    expect(scopeFilesToRoot(tree, "apps/web")).toEqual(["package.json", "app/page.tsx"]);
    const rootFiles = scopeFilesToRoot(tree, "");
    expect(rootFiles).toContain("package.json");
    expect(rootFiles).toContain("next.config.js");
    expect(rootFiles).not.toContain("apps/web/app/page.tsx");
  });
});
