/**
 * Phase 2 — pure six-template detector.
 *
 * Canonical home for framework classification. No node builtins, no I/O,
 * no network, no database — safe to import in the browser (`apps/web`)
 * and on the API (`apps/api`). Versions are NEVER used for classification,
 * only package names, scripts and structural files.
 */
import type { TemplateId } from "@repo/templates/runtime";

export type { TemplateId };

/** Canonical display names — single source for every UI. */
export const TEMPLATE_META: Record<TemplateId, { name: string }> = {
  NEXTJS: { name: "Next.js" },
  EXPRESS: { name: "Express" },
  HONO: { name: "Hono" },
  REACT: { name: "React" },
  ANGULAR: { name: "Angular" },
  VUE: { name: "Vue" },
};

export const SUPPORTED_TEMPLATES: readonly TemplateId[] = [
  "NEXTJS",
  "EXPRESS",
  "HONO",
  "REACT",
  "ANGULAR",
  "VUE",
];

export interface InspectionPackageJson {
  dependencies?: Record<string, string> | null;
  devDependencies?: Record<string, string> | null;
  peerDependencies?: Record<string, string> | null;
  scripts?: Record<string, string> | null;
}

/** One application root: repo-relative root dir + its files + package.json. */
export interface AppRootInspection {
  /** "" for the repository root, otherwise e.g. "apps/web". */
  root: string;
  /** Paths relative to the root, posix, e.g. "src/main.tsx". */
  files: string[];
  packageJson?: InspectionPackageJson | null;
}

export interface RepositoryInspection {
  roots: AppRootInspection[];
  /** True when the GitHub tree was truncated: evidence is incomplete. */
  truncated: boolean;
}

export interface SupportedCandidate {
  template: TemplateId;
  root: string;
}

export interface SupportedDetection {
  kind: "supported";
  template: TemplateId;
  /** Repo-relative root of the detected application ("" = repo root). */
  root: string;
  confidence: number;
  reasons: string[];
  truncated?: boolean;
}

export interface AmbiguousDetection {
  kind: "ambiguous";
  candidates: SupportedCandidate[];
  reasons: string[];
  truncated?: boolean;
}

export interface UnsupportedDetection {
  kind: "unsupported";
  reasons: string[];
  truncated?: boolean;
}

export type RootDetection = SupportedDetection | AmbiguousDetection | UnsupportedDetection;
export type TemplateDetection = RootDetection;

type Bag = {
  deps: Set<string>;
  scripts: Record<string, string>;
  files: Set<string>;
};

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function toBag(root: AppRootInspection): Bag {
  const deps = new Set<string>();
  const pkg = root.packageJson;
  for (const group of [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies]) {
    if (!group || typeof group !== "object") continue;
    for (const name of Object.keys(group)) deps.add(name.toLowerCase());
  }
  const scripts: Record<string, string> = {};
  if (pkg?.scripts && typeof pkg.scripts === "object") {
    for (const [k, v] of Object.entries(pkg.scripts)) {
      if (typeof v === "string") scripts[k.toLowerCase()] = v.toLowerCase();
    }
  }
  const files = new Set(root.files.map(normalizePath).filter(Boolean));
  return { deps, scripts, files };
}

function hasFile(files: Set<string>, ...names: string[]): string | null {
  for (const n of names) if (files.has(n)) return n;
  return null;
}

function hasFilePattern(files: Set<string>, re: RegExp): string | null {
  for (const f of files) if (re.test(f)) return f;
  return null;
}

function scriptMentions(scripts: Record<string, string>, ...tokens: string[]): string | null {
  for (const [name, body] of Object.entries(scripts)) {
    for (const t of tokens) if (body.includes(t)) return name;
  }
  return null;
}

interface ScoredHit {
  template: TemplateId;
  confidence: number;
  reasons: string[];
}

/**
 * Score a single application root. Never returns ambiguous for one
 * framework; when two frameworks match the same root it returns ambiguous
 * with both candidates (same root). Pure.
 */
export function detectAppRoot(input: AppRootInspection): RootDetection {
  const where = input.root === "" ? "repo root" : `“${input.root}”`;
  const { deps, scripts, files } = toBag(input);
  const has = (name: string) => deps.has(name.toLowerCase());

  if (!input.packageJson) {
    return {
      kind: "unsupported",
      reasons: [`${where}: no package.json found; unsupported project type`],
    };
  }

  // Nuxt is explicitly NOT Vue, even though it depends on vue.
  if (
    has("nuxt") ||
    has("@nuxt/kit") ||
    has("@nuxt/schema") ||
    hasFile(files, "nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs")
  ) {
    return {
      kind: "unsupported",
      reasons: [`${where}: Nuxt detected (nuxt dependency/config); Nuxt is not a supported template`],
    };
  }

  const hits: ScoredHit[] = [];

  // NEXTJS — `next` wins over plain React unconditionally.
  if (has("next")) {
    let confidence = 0.6;
    const reasons = [`${where}: dependency "next"`];
    const struct =
      hasFile(files, "app/page.tsx", "app/page.jsx", "app/page.js", "pages/_app.tsx", "pages/_app.jsx", "pages/_app.js", "pages/index.tsx", "pages/index.jsx", "pages/index.js") ??
      hasFilePattern(files, /^next\.config\.(js|mjs|cjs|ts)$/);
    if (struct) {
      confidence += 0.15;
      reasons.push(`${where}: Next.js structure "${struct}"`);
    }
    if (has("react")) {
      confidence += 0.1;
      reasons.push(`${where}: dependency "react" (expected for Next.js)`);
    }
    if (has("eslint-config-next")) {
      confidence += 0.05;
      reasons.push(`${where}: dependency "eslint-config-next"`);
    }
    if (scriptMentions(scripts, "next dev", "next build", "next start")) {
      confidence += 0.05;
      reasons.push(`${where}: next.js npm script`);
    }
    hits.push({ template: "NEXTJS", confidence: Math.min(confidence, 0.95), reasons });
  }

  // ANGULAR — requires BOTH @angular/core and angular.json.
  if (has("@angular/core")) {
    const marker = hasFile(files, "angular.json");
    if (marker) {
      let confidence = 0.75;
      const reasons = [
        `${where}: dependency "@angular/core"`,
        `${where}: Angular workspace "${marker}"`,
      ];
      const entry = hasFile(files, "src/main.ts", "src/main.js");
      if (entry) {
        confidence += 0.1;
        reasons.push(`${where}: Angular entry "${entry}"`);
      }
      hits.push({ template: "ANGULAR", confidence: Math.min(confidence, 0.95), reasons });
    } else {
      return {
        kind: "unsupported",
        reasons: [
          `${where}: dependency "@angular/core" without angular.json; Angular indicators required`,
        ],
      };
    }
  }

  // HONO
  if (has("hono")) {
    let confidence = 0.7;
    const reasons = [`${where}: dependency "hono"`];
    if (has("@hono/node-server")) {
      confidence += 0.1;
      reasons.push(`${where}: dependency "@hono/node-server"`);
    }
    const entry = hasFile(files, "src/index.ts", "src/index.js", "src/app.ts", "src/index.mjs");
    if (entry) {
      confidence += 0.1;
      reasons.push(`${where}: entry "${entry}"`);
    }
    hits.push({ template: "HONO", confidence: Math.min(confidence, 0.95), reasons });
  }

  // EXPRESS — never confused with Hono: both present => ambiguous.
  if (has("express")) {
    let confidence = 0.7;
    const reasons = [`${where}: dependency "express"`];
    const entry = hasFile(files, "index.js", "server.js", "app.js", "src/index.js", "src/server.js", "src/app.js", "src/index.ts");
    if (entry) {
      confidence += 0.1;
      reasons.push(`${where}: server entry "${entry}"`);
    }
    if (scriptMentions(scripts, "node ", "node index", "express")) {
      confidence += 0.05;
      reasons.push(`${where}: node start script`);
    }
    hits.push({ template: "EXPRESS", confidence: Math.min(confidence, 0.95), reasons });
  }

  // VUE (Nuxt already rejected above).
  if (has("vue")) {
    const struct =
      hasFile(files, "src/App.vue", "src/main.js", "src/main.ts", "vue.config.js", "public/index.html") ??
      hasFilePattern(files, /^vite\.config\.(js|mjs|cjs|ts)$/);
    if (struct) {
      const reasons = [`${where}: dependency "vue"`, `${where}: Vue structure "${struct}"`];
      hits.push({ template: "VUE", confidence: 0.85, reasons });
    } else {
      return {
        kind: "unsupported",
        reasons: [`${where}: dependency "vue" without Vue entry/structure (src/App.vue, src/main.*)`],
      };
    }
  }

  // REACT — only when NOT Next.js; requires a bundler/entry signal.
  if (has("react") && !has("next")) {
    const bundler =
      has("vite") ||
      has("@vitejs/plugin-react") ||
      has("react-scripts") ||
      has("parcel") ||
      has("webpack") ||
      scriptMentions(scripts, "vite", "react-scripts") !== null;
    const entry = hasFile(
      files,
      "src/main.tsx",
      "src/main.jsx",
      "src/index.tsx",
      "src/index.jsx",
      "src/App.tsx",
      "src/App.jsx",
      "src/main.js",
      "src/index.js",
      "index.html",
    );
    if (bundler || entry) {
      let confidence = 0.6;
      const reasons = [`${where}: dependency "react"`];
      if (bundler) {
        confidence += 0.15;
        reasons.push(`${where}: React bundler/tooling signal`);
      }
      if (entry) {
        confidence += 0.1;
        reasons.push(`${where}: React entry "${entry}"`);
      }
      hits.push({ template: "REACT", confidence: Math.min(confidence, 0.95), reasons });
    } else {
      return {
        kind: "unsupported",
        reasons: [`${where}: dependency "react" without bundler or entry signal`],
      };
    }
  }

  if (hits.length === 0) {
    return {
      kind: "unsupported",
      reasons: [`${where}: no supported framework signature (package names, scripts, structure)`],
    };
  }
  if (hits.length === 1) {
    const hit = hits[0]!;
    return {
      kind: "supported",
      template: hit.template,
      root: input.root,
      confidence: hit.confidence,
      reasons: hit.reasons,
    };
  }
  // Two frameworks in one root (e.g. express + hono): never guess.
  hits.sort((a, b) => b.confidence - a.confidence);
  return {
    kind: "ambiguous",
    candidates: hits.map((h) => ({ template: h.template, root: input.root })),
    reasons: [
      `${where}: multiple frameworks detected (${hits.map((h) => h.template).join(", ")}); refusing to choose`,
    ],
  };
}

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  "vendor",
  "__tests__",
  "__mocks__",
]);

/**
 * Discover application roots from a recursive tree path list: every
 * `package.json` at depth <= 3 (repo root + 3 levels), ignoring generated
 * and fixture directories. Pure.
 */
export function findAppRoots(treePaths: string[]): string[] {
  const roots = new Set<string>();
  for (const raw of treePaths) {
    const p = normalizePath(raw);
    const segs = p.split("/");
    if (segs[segs.length - 1] !== "package.json") continue;
    if (segs.some((s) => IGNORED_SEGMENTS.has(s))) continue;
    if (segs.length - 1 > 3) continue;
    roots.add(segs.slice(0, -1).join("/"));
  }
  return [...roots].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
}

/** Scope tree paths to one root (relative paths). Pure. */
export function scopeFilesToRoot(treePaths: string[], root: string): string[] {
  const prefix = root === "" ? "" : `${root}/`;
  const out: string[] = [];
  for (const raw of treePaths) {
    const p = normalizePath(raw);
    if (root === "") {
      // Repo-root scope keeps only top-level package.json context; nested
      // app files are evaluated under their own root, not the repo root.
      const segs = p.split("/");
      if (segs.length > 1 && segs[1] === "package.json" && segs.length === 2) {
        out.push(p);
        continue;
      }
      if (!p.includes("/")) {
        out.push(p);
        continue;
      }
      // Top-level config files still inform the root (next.config.js etc.).
      if (segs.length === 2 && /^(next|vite|vue|angular|nuxt|wrangler).*|^(package\.json|index\.(js|ts|mjs))$/.test(segs[1]!)) {
        out.push(p);
      }
      continue;
    }
    if (p === `${root}/package.json` || p.startsWith(prefix)) {
      out.push(p.slice(prefix.length));
    }
  }
  return out;
}

/**
 * Aggregate per-root results into the repository verdict. Policy:
 * - truncated tree => unsupported (never a false SUPPORTED), flagged.
 * - no roots => unsupported.
 * - exactly one supported root and no other *supported* roots => supported
 *   (extra files, other languages, or unknown package.json roots are noise
 *   and only add a note reason; they never silently change the verdict).
 * - two or more supported roots (same or different templates) => ambiguous
 *   with per-root candidates so import UI can offer a subdirectory choice.
 * Pure.
 */
export function detectRepository(input: RepositoryInspection): TemplateDetection {
  if (input.truncated) {
    return {
      kind: "unsupported",
      truncated: true,
      reasons: [
        "inspection incomplete: GitHub recursive tree is truncated (repository too large); refusing to classify without full evidence",
      ],
    };
  }
  if (input.roots.length === 0) {
    return {
      kind: "unsupported",
      reasons: ["no package.json found in repository; unsupported project type"],
    };
  }
  const perRoot = input.roots.map((r) => ({ root: r.root, result: detectAppRoot(r) }));
  const supported = perRoot.filter(
    (r): r is { root: string; result: SupportedDetection } => r.result.kind === "supported",
  );
  const ambiguous = perRoot.filter((r) => r.result.kind === "ambiguous");

  const candidates: SupportedCandidate[] = [
    ...supported.map((s) => ({ template: s.result.template, root: s.root })),
    ...ambiguous.flatMap((a) => (a.result as AmbiguousDetection).candidates),
  ];

  if (supported.length === 1 && ambiguous.length === 0) {
    const only = supported[0]!;
    const result = only.result;
    const reasons = [...result.reasons];
    if (input.roots.length > 1) {
      reasons.push(
        `note: ${input.roots.length - 1} other package.json root(s) present but without a competing supported app; dominant application is ${result.template}`,
      );
    }
    return { ...result, reasons };
  }
  if (candidates.length === 0) {
    return {
      kind: "unsupported",
      reasons: perRoot.flatMap((r) =>
        (r.result as UnsupportedDetection).reasons ?? [`"${r.root || "/"}": unsupported`],
      ),
    };
  }
  // Multiple supported roots, or a mix involving ambiguous roots.
  const labels = candidates.map((c) => `${c.root || "/"} → ${c.template}`).join(", ");
  return {
    kind: "ambiguous",
    candidates,
    reasons: [`multiple supported applications detected (${labels}); choose an application root to import`],
  };
}
