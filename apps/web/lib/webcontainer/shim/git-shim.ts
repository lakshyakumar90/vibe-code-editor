/**
 * Terminal Git shim — runs INSIDE the WebContainer Node runtime.
 *
 * Bundled with esbuild (platform=node, format=cjs) into
 * `apps/web/public/vibe/git-shim.cjs`, fetched by the browser at boot and
 * written to the container FS at `/.vibe/git-shim.cjs`. Invoked one-shot via
 * `container.spawn("node", ["/.vibe/git-shim.cjs", ...args])`.
 *
 * Scope: LOCAL git commands only. Network remotes (fetch/pull/push/clone)
 * are blocked by policy — authenticated GitHub operations live server-side
 * in the Source Control panel. No credentials are ever read or written here.
 *
 * Env:
 *   VIBE_GIT_DIR   working repo root (default "/")
 *   VIBE_GIT_NAME  commit author name fallback
 *   VIBE_GIT_EMAIL commit author email fallback
 *   VIBE_GIT_HOSTS comma-separated allowed https remote hosts
 *                  (default "github.com")
 */

import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";

/* eslint-disable turbo/no-undeclared-env-vars -- VIBE_GIT_* are read inside
   the WebContainer at terminal-runtime, never as Next.js build inputs. */

const DIR = process.env["VIBE_GIT_DIR"] || "/";
const ALLOWED_HOSTS = (process.env["VIBE_GIT_HOSTS"] || "github.com")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const out: string[] = [];
const err: string[] = [];
const say = (s = "") => out.push(s);
const warn = (s = "") => err.push(s);
function fail(code: number, msg: string): never {
  warn(msg);
  flush();
  process.exit(code);
}
function flush() {
  if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
  if (err.length > 0) process.stderr.write(err.join("\n") + "\n");
}

/** Directories never added, scanned, or synced by the shim. */
const IGNORED_TOP = new Set([
  ".git",
  ".vibe",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
]);

async function repoExists(): Promise<boolean> {
  try {
    const st = await fs.promises.stat(path.join(DIR, ".git"));
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function ensureRepo(subcommand: string): Promise<void> {
  if (!(await repoExists())) {
    fail(
      128,
      `fatal: not a git repository (or any of the parent directories): .git (${subcommand})`,
    );
  }
}

function isValidBranchName(name: string): boolean {
  if (!name || name === "HEAD") return false;
  if (/[\s~^:?*[\]\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("//")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".lock")) return false;
  if (name.startsWith("-") || name.includes("@{")) return false;
  return true;
}

interface Identity {
  name: string;
  email: string;
}

async function identity(): Promise<Identity> {
  let name = process.env["VIBE_GIT_NAME"]?.trim() || "";
  let email = process.env["VIBE_GIT_EMAIL"]?.trim() || "";
  try {
    if (!name) name = (await git.getConfig({ fs, dir: DIR, path: "user.name" })) || "";
  } catch {
    /* unset */
  }
  try {
    if (!email) email = (await git.getConfig({ fs, dir: DIR, path: "user.email" })) || "";
  } catch {
    /* unset */
  }
  return {
    name: name || "vibe",
    email: email || "vibe@vibe.local",
  };
}

type MatrixRow = [string, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];

async function matrix(): Promise<MatrixRow[]> {
  const rows = (await git.statusMatrix({ fs, dir: DIR })) as MatrixRow[];
  const now = Date.now();
  const out: MatrixRow[] = [];
  for (const row of rows) {
    // Project-model view: runtime metadata (container .git, shim home,
    // installed deps, build output) is invisible to terminal git, matching
    // the File model (which never contains these paths).
    const top = row[0].split("/")[0]!;
    if (IGNORED_TOP.has(top)) continue;
    // Racy-git guard: same-second, same-size edits can fool stat comparison
    // into a false "unmodified". Real git re-hashes such entries; do the
    // same for recently-touched files so `status` right after a save is
    // accurate. Bounded to racy candidates only.
    if (row[1] === 1 && row[2] === 1 && row[3] === 1) {
      try {
        const st = await fs.promises.stat(path.join(DIR, row[0]));
        if (now - st.mtimeMs < 2000) {
          const [head, work] = await Promise.all([readHeadBlob(row[0]), readWorkdir(row[0])]);
          if (head !== null && work !== null && head !== work) {
            out.push([row[0], 1, 2, 1]);
            continue;
          }
        }
      } catch {
        /* fall through as unmodified */
      }
    }
    out.push(row);
  }
  return out;
}

function classify(row: MatrixRow): "unmodified" | "modified-unstaged" | "modified-staged" | "added" | "deleted-unstaged" | "deleted-staged" | "untracked" {
  const [, h, w, s] = row;
  if (h === 1 && w === 1 && s === 1) return "unmodified";
  if (h === 0 && w === 2 && s === 0) return "untracked";
  if (h === 0 && s === 2) return "added";
  if (h === 1 && w === 0 && s === 0) return "deleted-staged";
  if (h === 1 && w === 0) return "deleted-unstaged";
  if (s === 2) return "modified-staged";
  if (w === 2) return "modified-unstaged";
  return "unmodified";
}

function shortCode(row: MatrixRow): string {
  const c = classify(row);
  switch (c) {
    case "unmodified":
      return "  ";
    case "untracked":
      return "??";
    case "added":
      return "A ";
    case "deleted-staged":
      return "D ";
    case "deleted-unstaged":
      return " D";
    case "modified-staged":
      return "M ";
    case "modified-unstaged":
      return " M";
  }
}

/** Normalize a user pathspec to a repo-relative posix path (no escapes). */
function normSpec(spec: string): string {
  let s = spec.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  if (s === "" || s === ".") return "";
  return s;
}

/** Does matrix row path match the pathspec (exact or dir-prefix, filtered)? */
function specMatches(filepath: string, spec: string): boolean {
  if (spec === "") return true;
  if (filepath === spec) return true;
  if (filepath.startsWith(spec + "/")) return true;
  return false;
}

function specIsOutsideRepo(spec: string): boolean {
  return spec === ".." || spec.startsWith("../") || path.posix.isAbsolute("/" + spec) === false && spec.includes("..");
}

async function cmdVersion(): Promise<void> {
  say("git version 2.44.0.vibe-shim");
}

async function cmdHelp(): Promise<void> {
  say(`usage: git [-v | --version] [-h | --help]
   git init [-b <branch>]
   git status [-s | --short]
   git add <path>... | -A | .
   git diff [--staged] [-- <path>...]
   git commit -m <msg> [-a]
   git log [--oneline] [-n <count>] [<ref>]
   git branch [<name>] [-d | -D <name>]
   git switch <branch> | -c <new-branch>
   git checkout <branch> | -b <new-branch> | [--] <path>...
   git restore [--staged] [--source <ref>] <path>...
   git reset [--soft | --mixed | --hard] [<commit>] [-- <path>...]
   git remote [-v] | add <name> <url> | remove <name> | set-url <name> <url>
   git config user.name|user.email [value]

Terminal git is local to this project runtime.
Authenticated GitHub operations (fetch/pull/push) run through Source Control.`);
}

async function cmdInit(args: string[]): Promise<void> {
  let branch = "main";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-b" || args[i] === "--initial-branch") {
      branch = args[++i] ?? "";
    } else if (args[i]?.startsWith("--initial-branch=")) {
      branch = args[i]!.split("=", 2)[1] ?? "";
    } else {
      fail(129, `usage: git init [-b <branch-name>]`);
    }
  }
  if (!isValidBranchName(branch)) fail(128, `fatal: '${branch}' is not a valid branch name`);
  const existed = await repoExists();
  await git.init({ fs, dir: DIR, defaultBranch: branch });
  say(
    existed
      ? `Reinitialized existing Git repository in ${DIR}.git/`
      : `Initialized empty Git repository in ${DIR}.git/`,
  );
}

async function shortStatus(): Promise<void> {
  const rows = await matrix();
  for (const row of rows) {
    const code = shortCode(row);
    if (code !== "  ") say(`${code} ${row[0]}`);
  }
}

async function cmdStatus(args: string[]): Promise<void> {
  await ensureRepo("status");
  const short = args.includes("-s") || args.includes("--short");
  if (short) {
    await shortStatus();
    return;
  }
  for (const a of args) {
    if (a.startsWith("-")) fail(129, `option '${a}' is not supported by the terminal shim`);
  }
  const branch = (await git.currentBranch({ fs, dir: DIR })) || "HEAD";
  const rows = await matrix();
  const stagedNew: string[] = [];
  const stagedMod: string[] = [];
  const stagedDel: string[] = [];
  const unstagedMod: string[] = [];
  const unstagedDel: string[] = [];
  const untracked: string[] = [];
  for (const row of rows) {
    const c = classify(row);
    const f = row[0];
    if (c === "added") stagedNew.push(f);
    else if (c === "modified-staged") stagedMod.push(f);
    else if (c === "deleted-staged") stagedDel.push(f);
    else if (c === "modified-unstaged") unstagedMod.push(f);
    else if (c === "deleted-unstaged") unstagedDel.push(f);
    else if (c === "untracked") untracked.push(f);
  }
  let head: string | null = null;
  try {
    head = await git.resolveRef({ fs, dir: DIR, ref: "HEAD" });
  } catch {
    head = null;
  }
  say(`On branch ${branch}`);
  if (head === null) say("No commits yet");
  if (stagedNew.length + stagedMod.length + stagedDel.length > 0) {
    say("Changes to be committed:");
    for (const f of stagedNew) say(`\tnew file:   ${f}`);
    for (const f of stagedMod) say(`\tmodified:   ${f}`);
    for (const f of stagedDel) say(`\tdeleted:    ${f}`);
  }
  if (unstagedMod.length + unstagedDel.length > 0) {
    say("Changes not staged for commit:");
    for (const f of unstagedMod) say(`\tmodified:   ${f}`);
    for (const f of unstagedDel) say(`\tdeleted:    ${f}`);
  }
  if (untracked.length > 0) {
    say("Untracked files:");
    for (const f of untracked) say(`\t${f}`);
  }
  if (
    stagedNew.length + stagedMod.length + stagedDel.length + unstagedMod.length + unstagedDel.length + untracked.length === 0
  ) {
    say("nothing to commit, working tree clean");
  }
}

async function cmdAdd(args: string[]): Promise<void> {
  await ensureRepo("add");
  if (args.length === 0) fail(129, "usage: git add <path>... | -A | .");
  let all = false;
  const specs: string[] = [];
  for (const a of args) {
    if (a === "-A" || a === "--all" || a === "-u" || a === "--update" || a === ".") {
      all = true;
    } else if (a === "-p" || a === "--patch" || a === "-i" || a === "--interactive") {
      fail(1, `option '${a}' is not supported by the terminal shim`);
    } else if (a.startsWith("-")) {
      fail(129, `unknown option '${a}'`);
    } else {
      const s = normSpec(a);
      if (specIsOutsideRepo(s) && s !== "") fail(128, `fatal: '${a}' is outside repository`);
      specs.push(s);
    }
  }
  const rows = await matrix();
  const targets = rows.filter((row) => {
    const top = row[0].split("/")[0]!;
    if (IGNORED_TOP.has(top)) return false;
    const c = classify(row);
    if (c === "unmodified") return false;
    if (all) {
      // -u semantics would skip untracked; -A includes them. Treat all/-A/.
      // as "add everything" (documented simplification matches `git add -A`).
      return true;
    }
    return specs.some((s) => specMatches(row[0], s));
  });
  if (!all && targets.length === 0) {
    const missing = specs.filter((s) => s !== "" && !rows.some((r) => specMatches(r[0], s)));
    if (missing.length > 0) fail(128, `fatal: pathspec '${missing[0]}' did not match any files`);
  }
  for (const row of targets) {
    const c = classify(row);
    if (c === "deleted-unstaged") {
      await git.remove({ fs, dir: DIR, filepath: row[0] });
    } else {
      await git.add({ fs, dir: DIR, filepath: row[0] });
    }
  }
}

/** Minimal unified diff (LCS on lines). Binary-aware via NUL sniffing. */
function unifiedDiff(rel: string, oldText: string | null, newText: string | null): string {
  const hasNul = (s: string | null) => (s !== null && s.includes("\0") ? true : false);
  if (hasNul(oldText) || hasNul(newText)) {
    return `diff --git a/${rel} b/${rel}\nBinary files differ\n`;
  }
  const a = oldText === null ? [] : oldText.split("\n");
  const b = newText === null ? [] : newText.split("\n");
  if (oldText !== null && newText !== null && oldText === newText) return "";
  // LCS table (files here are bounded by MAX_DIFF_LINES below).
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1]! + 1) : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  type Op = { t: " " | "-" | "+"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ t: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ t: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++]! });
  while (j < m) ops.push({ t: "+", line: b[j++]! });
  // Single hunk covering the whole change (context lines included inline).
  let outText = `diff --git a/${rel} b/${rel}\n`;
  outText += oldText === null ? `new file mode 100644\n--- /dev/null\n+++ b/${rel}\n` : newText === null ? `deleted file mode 100644\n--- a/${rel}\n+++ /dev/null\n` : `--- a/${rel}\n+++ b/${rel}\n`;
  // Single hunk covering the whole change with computed ranges.
  const aCount = ops.filter((o) => o.t !== "+").length;
  const bCount = ops.filter((o) => o.t !== "-").length;
  outText += `@@ -${n === 0 ? 0 : 1},${aCount} +${m === 0 ? 0 : 1},${bCount} @@\n`;
  for (const op of ops) outText += `${op.t}${op.line}\n`;
  return outText;
}

const MAX_DIFF_LINES = 2000;
const MAX_DIFF_BYTES = 200_000;

async function readHeadBlob(filepath: string, ref = "HEAD"): Promise<string | null> {
  try {
    const oid = await resolveRevision(ref);
    const { blob } = await git.readBlob({ fs, dir: DIR, oid, filepath });
    const buf = Buffer.from(blob);
    if (buf.length > MAX_DIFF_BYTES) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Revision expressions (`HEAD`, `HEAD~2`, `main^`, branch names, full shas).
 * isomorphic-git's resolveRef handles direct refs only, so ancestry is
 * walked manually. Short shas are intentionally unsupported (ambiguous).
 */
async function resolveRevision(rev: string): Promise<string> {
  const m = /^(.*?)([~^])(\d*)$/.exec(rev);
  if (m && m[1] !== "") {
    const baseOid = await resolveRevision(m[1]!);
    if (m[2] === "~") {
      const n = m[3] === "" ? 1 : Number(m[3]);
      let oid = baseOid;
      for (let k = 0; k < n; k++) {
        const c = await git.readCommit({ fs, dir: DIR, oid });
        const parent = c.commit.parent[0];
        if (!parent) throw new Error(`unknown revision '${rev}'`);
        oid = parent;
      }
      return oid;
    }
    const idx = m[3] === "" ? 0 : Number(m[3]) - 1;
    const c = await git.readCommit({ fs, dir: DIR, oid: baseOid });
    const parent = c.commit.parent[idx];
    if (!parent) throw new Error(`unknown revision '${rev}'`);
    return parent;
  }
  try {
    return await git.resolveRef({ fs, dir: DIR, ref: rev });
  } catch {
    /* not a ref — maybe a full sha */
  }
  if (/^[0-9a-f]{40}$/i.test(rev)) {
    try {
      await git.readObject({ fs, dir: DIR, oid: rev });
      return rev.toLowerCase();
    } catch {
      /* unknown object */
    }
  }
  throw new Error(`unknown revision '${rev}'`);
}

/** Staged blob content via walk(STAGE). Null when path has no staged blob. */
async function readStageBlob(filepath: string): Promise<string | null | undefined> {
  // undefined = unknown (walk error); null = absent from stage.
  try {
    let found: { oid: string | null; found: boolean } = { oid: null, found: false };
    await git.walk({
      fs,
      dir: DIR,
      trees: [git.STAGE()],
      map: async (name, [entry]) => {
        if (name === filepath && entry) {
          found = { oid: await entry.oid(), found: true };
        }
        // Return undefined always: any other value prunes the walk.
        return undefined;
      },
    });
    if (!found.found || !found.oid) return null;
    const { blob } = await git.readBlob({ fs, dir: DIR, oid: found.oid });
    const buf = Buffer.from(blob);
    if (buf.length > MAX_DIFF_BYTES) return null;
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}

async function readWorkdir(filepath: string): Promise<string | null> {
  try {
    const st = await fs.promises.stat(path.join(DIR, filepath));
    if (!st.isFile() || st.size > MAX_DIFF_BYTES) return null;
    return await fs.promises.readFile(path.join(DIR, filepath), "utf8");
  } catch {
    return null;
  }
}

async function cmdDiff(args: string[]): Promise<void> {
  await ensureRepo("diff");
  let staged = false;
  let ref: string | null = null;
  const paths: string[] = [];
  let endOfOpts = false;
  for (const a of args) {
    if (!endOfOpts && a === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && (a === "--staged" || a === "--cached")) {
      staged = true;
      continue;
    }
    if (!endOfOpts && a.startsWith("-")) fail(129, `option '${a}' is not supported by the terminal shim`);
    if (!endOfOpts && ref === null && paths.length === 0 && /^[0-9a-f]{4,40}$/i.test(a)) {
      // Ambiguous sha vs path: treat as ref only when it resolves.
      try {
        await resolveRevision(a);
        ref = a;
        continue;
      } catch {
        /* fall through to path */
      }
    }
    if (!endOfOpts && ref === null && paths.length === 0) {
      try {
        await resolveRevision(a);
        ref = a;
        continue;
      } catch {
        /* not a revision — treat as path */
      }
    }
    paths.push(normSpec(a));
  }
  const rows = await matrix();
  const wanted = rows.filter((row) => {
    const c = classify(row);
    if (c === "untracked") return false;
    if (paths.length > 0 && !paths.some((s) => specMatches(row[0], s))) return false;
    // Against an explicit ref, content comparison decides (a file clean vs
    // HEAD may still differ from the ref).
    if (ref !== null) return true;
    if (c === "unmodified") return false;
    if (staged) return c === "modified-staged" || c === "added" || c === "deleted-staged";
    return c === "modified-unstaged" || c === "deleted-unstaged";
  });
  for (const row of wanted) {
    const f = row[0];
    const oldText = await readHeadBlob(f, ref ?? "HEAD");
    let newText: string | null | undefined;
    if (staged) {
      newText = await readStageBlob(f);
      if (newText === undefined) newText = await readWorkdir(f);
    } else {
      newText = await readWorkdir(f);
    }
    if (oldText === null && newText === null) {
      say(`diff --git a/${f} b/${f}\nBinary files differ or file too large`);
      continue;
    }
    if (oldText !== null && newText !== null && oldText === newText) continue;
    const lines = (oldText ?? "").split("\n").length + (newText ?? "").split("\n").length;
    if (lines > MAX_DIFF_LINES) {
      say(`diff --git a/${f} b/${f}\nFile too large to show in terminal diff`);
      continue;
    }
    const text = unifiedDiff(f, oldText, newText ?? null);
    if (text) say(text.trimEnd());
  }
}

async function cmdCommit(args: string[]): Promise<void> {
  await ensureRepo("commit");
  let message: string | null = null;
  let all = false;
  let allowEmpty = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-m" || a === "--message") {
      const v = args[++i];
      if (v === undefined) fail(129, "option '-m' requires a value");
      message = message === null ? v : message + "\n\n" + v;
    } else if (a.startsWith("-m")) {
      const v = a.slice(2);
      message = message === null ? v : message + "\n\n" + v;
    } else if (a === "-a" || a === "--all") {
      all = true;
    } else if (a === "--allow-empty") {
      allowEmpty = true;
    } else if (a === "--amend" || a === "-p" || a === "--patch") {
      fail(1, `option '${a}' is not supported by the terminal shim`);
    } else if (a.startsWith("-")) {
      fail(129, `unknown option '${a}'`);
    } else {
      fail(129, "usage: git commit -m <msg> [-a]");
    }
  }
  if (message === null || message.trim() === "") fail(1, "Aborting commit due to empty commit message.");
  if (all) {
    const rows = await matrix();
    for (const row of rows) {
      const top = row[0].split("/")[0]!;
      if (IGNORED_TOP.has(top)) continue;
      const c = classify(row);
      if (c === "modified-unstaged" || c === "deleted-unstaged") {
        if (c === "deleted-unstaged") await git.remove({ fs, dir: DIR, filepath: row[0] });
        else await git.add({ fs, dir: DIR, filepath: row[0] });
      }
    }
  }
  const rows = await matrix();
  const stagedCount = rows.filter((r) => {
    const c = classify(r);
    return c === "added" || c === "modified-staged" || c === "deleted-staged";
  }).length;
  if (stagedCount === 0 && !allowEmpty) {
    fail(1, "nothing to commit, working tree clean");
  }
  const id = await identity();
  const sha = await git.commit({
    fs,
    dir: DIR,
    message: message.trim(),
    author: { name: id.name, email: id.email },
  });
  const branch = (await git.currentBranch({ fs, dir: DIR })) || "HEAD";
  say(`[${branch} ${sha.slice(0, 7)}] ${message.trim().split("\n")[0]}`);
}

async function cmdLog(args: string[]): Promise<void> {
  await ensureRepo("log");
  let oneline = false;
  let depth: number | undefined;
  let ref = "HEAD";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--oneline") oneline = true;
    else if (a === "-n" || a === "--max-count") {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v <= 0) fail(129, "option '-n' requires a positive count");
      depth = v;
    } else if (/^-n\d+$/.test(a)) {
      depth = Number(a.slice(2));
    } else if (a === "--") {
      fail(1, "path-filtered log is not supported by the terminal shim; use Source Control history.");
    } else if (a.startsWith("-")) {
      fail(129, `option '${a}' is not supported by the terminal shim`);
    } else {
      ref = a;
    }
  }
  let commits;
  try {
    const oid = await resolveRevision(ref);
    commits = await git.log({ fs, dir: DIR, ref: oid, depth: depth ?? 50 });
  } catch {
    fail(128, `fatal: ambiguous argument '${ref}': unknown revision`);
  }
  for (const c of commits!) {
    if (oneline) {
      say(`${c.oid.slice(0, 7)} ${c.commit.message.split("\n")[0]}`);
    } else {
      say(`commit ${c.oid}`);
      say(`Author: ${c.commit.author.name} <${c.commit.author.email}>`);
      say(`Date:   ${new Date(c.commit.author.timestamp * 1000).toUTCString()}`);
      say("");
      for (const line of c.commit.message.split("\n")) say(`    ${line}`);
      say("");
    }
  }
}

async function cmdBranch(args: string[]): Promise<void> {
  await ensureRepo("branch");
  if (args.length === 0) {
    const current = await git.currentBranch({ fs, dir: DIR });
    const branches = await git.listBranches({ fs, dir: DIR });
    for (const b of branches) say(`${b === current ? "*" : " "} ${b}`);
    return;
  }
  if (args[0] === "-d" || args[0] === "-D") {
    const force = args[0] === "-D";
    const name = args[1];
    if (!name) fail(129, `usage: git branch -d <branch>`);
    const current = await git.currentBranch({ fs, dir: DIR });
    if (name === current) fail(1, `error: Cannot delete branch '${name}' checked out here`);
    let tip: string;
    try {
      tip = await git.resolveRef({ fs, dir: DIR, ref: name });
    } catch {
      fail(128, `error: branch '${name}' not found.`);
    }
    if (!force) {
      const head = await git.resolveRef({ fs, dir: DIR, ref: "HEAD" });
      const merged = await git.isDescendent({ fs, dir: DIR, oid: tip!, ancestor: head });
      if (!merged) fail(1, `error: The branch '${name}' is not fully merged. Use -D to force.`);
    }
    await git.deleteBranch({ fs, dir: DIR, ref: name });
    say(`Deleted branch ${name}.`);
    return;
  }
  if (args[0] === "-m" || args[0] === "-M") {
    const [oldName, newName] = [args[1], args[2]];
    if (!oldName || !newName) fail(129, "usage: git branch -m <old> <new>");
    if (!isValidBranchName(newName!)) fail(128, `fatal: '${newName}' is not a valid branch name`);
    await git.renameBranch({ fs, dir: DIR, oldref: oldName!, ref: newName!, checkout: false });
    return;
  }
  if (args[0]!.startsWith("-")) fail(129, `option '${args[0]}' is not supported by the terminal shim`);
  const name = args[0]!;
  if (!isValidBranchName(name)) fail(128, `fatal: '${name}' is not a valid branch name`);
  try {
    await git.resolveRef({ fs, dir: DIR, ref: name });
    fail(128, `fatal: A branch named '${name}' already exists.`);
  } catch (e) {
    if (e instanceof Error && e.message.includes("already exists")) throw e;
    /* not found — proceed */
  }
  await git.branch({ fs, dir: DIR, ref: name, checkout: false });
}

async function switchTo(branch: string, create: boolean): Promise<void> {
  if (!isValidBranchName(branch)) fail(128, `fatal: '${branch}' is not a valid branch name`);
  if (create) {
    try {
      await git.resolveRef({ fs, dir: DIR, ref: branch });
      fail(128, `fatal: A branch named '${branch}' already exists.`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("already exists")) throw e;
    }
    await git.branch({ fs, dir: DIR, ref: branch, checkout: false });
  }
  try {
    await git.checkout({ fs, dir: DIR, ref: branch });
  } catch (e) {
    if (e instanceof git.Errors.CheckoutConflictError) {
      fail(1, "error: Your local changes would be overwritten by checkout.\nCommit, stash-like restore, or reset them first.");
    }
    fail(128, `error: pathspec '${branch}' did not match any branch known to the terminal shim`);
  }
  say(`Switched to branch '${branch}'`);
}

async function cmdSwitch(args: string[]): Promise<void> {
  await ensureRepo("switch");
  if (args[0] === "-c" || args[0] === "--create") {
    const name = args[1];
    if (!name) fail(129, "usage: git switch -c <new-branch>");
    await switchTo(name, true);
    return;
  }
  if (args[0] === "-") fail(1, "switching to the previous branch is not supported by the terminal shim");
  if (!args[0] || args[0]!.startsWith("-")) fail(129, "usage: git switch <branch> | -c <new-branch>");
  await switchTo(args[0]!, false);
}

async function cmdCheckout(args: string[]): Promise<void> {
  await ensureRepo("checkout");
  if (args.length === 0) fail(129, "usage: git checkout <branch> | -b <name> | [--] <path>...");
  if (args[0] === "-b") {
    const name = args[1];
    if (!name) fail(129, "usage: git checkout -b <new-branch>");
    await switchTo(name, true);
    return;
  }
  // Path restore: [--] <paths> or <commit> -- <paths>.
  const dashdash = args.indexOf("--");
  if (dashdash !== -1) {
    const before = args.slice(0, dashdash);
    const pathArgs = args.slice(dashdash + 1);
    if (pathArgs.length === 0) fail(129, "usage: git checkout [<commit>] -- <path>...");
    const source = before.length === 0 ? "HEAD" : before.length === 1 ? before[0]! : null;
    if (source === null) fail(129, "usage: git checkout [<commit>] -- <path>...");
    await restorePathsFromRef(source, pathArgs);
    return;
  }
  if (args.length > 1) fail(129, "usage: git checkout <branch> | -b <name> | [--] <path>...");
  const target = args[0]!;
  // Branch if it resolves as one, else detached sha is unsupported.
  try {
    const branches = await git.listBranches({ fs, dir: DIR });
    if (branches.includes(target)) {
      await switchTo(target, false);
      return;
    }
  } catch {
    /* fall through */
  }
  if (/^[0-9a-f]{4,40}$/i.test(target)) {
    fail(1, "detached HEAD checkouts are not supported by the terminal shim");
  }
  fail(128, `error: pathspec '${target}' did not match any branch known to the terminal shim`);
}

/** Write ref's version of each pathspec-match into the workdir + stage. */
async function restorePathsFromRef(source: string, pathArgs: string[]): Promise<void> {
  let oid: string;
  try {
    oid = await resolveRevision(source);
  } catch {
    fail(128, `fatal: ambiguous argument '${source}': unknown revision`);
  }
  const specs = pathArgs.map((p) => normSpec(p));
  // Enumerate ref tree.
  const entries: string[] = [];
  const commit = await git.readCommit({ fs, dir: DIR, oid: oid! });
  async function walkTree(treeOid: string, prefix: string): Promise<void> {
    const { tree } = await git.readTree({ fs, dir: DIR, oid: treeOid });
    for (const e of tree) {
      const rel = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === "tree") await walkTree(e.oid, rel);
      else entries.push(rel);
    }
  }
  await walkTree(commit.commit.tree, "");
  const matched = entries.filter((f) => specs.some((s) => specMatches(f, s)));
  if (matched.length === 0) fail(128, `error: pathspec '${pathArgs[0]}' did not match any file(s) known to ${source}`);
  for (const f of matched) {
    const { blob } = await git.readBlob({ fs, dir: DIR, oid: oid!, filepath: f });
    const abs = path.join(DIR, f);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, Buffer.from(blob));
    await git.add({ fs, dir: DIR, filepath: f });
  }
}

async function cmdRestore(args: string[]): Promise<void> {
  await ensureRepo("restore");
  let staged = false;
  let workdir = false;
  let source: string | null = null;
  const paths: string[] = [];
  let endOfOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfOpts && a === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && a === "--staged") {
      staged = true;
      continue;
    }
    if (!endOfOpts && a === "--workdir") {
      workdir = true;
      continue;
    }
    if (!endOfOpts && a === "--source") {
      source = args[++i] ?? null;
      if (!source) fail(129, "option '--source' requires a value");
      continue;
    }
    if (!endOfOpts && a.startsWith("--source=")) {
      source = a.split("=", 2)[1]!;
      continue;
    }
    if (!endOfOpts && a.startsWith("-")) fail(129, `option '${a}' is not supported by the terminal shim`);
    paths.push(normSpec(a));
  }
  if (paths.length === 0) fail(129, "usage: git restore [--staged] [--source <ref>] <path>...");
  if (!staged && !workdir) workdir = true;
  const rows = await matrix();
  const matched = rows.filter((r) => paths.some((s) => specMatches(r[0], s)));
  if (matched.length === 0) fail(128, `error: pathspec '${args[args.length - 1]}' did not match any file(s)`);
  if (staged) {
    for (const r of matched) {
      try {
        await git.resetIndex({ fs, dir: DIR, filepath: r[0], ref: "HEAD" });
      } catch {
        fail(1, `error: could not unstage '${r[0]}'`);
      }
    }
  }
  if (workdir) {
    const src = source ?? "HEAD";
    await restorePathsFromRef(
      src,
      matched.map((r) => r[0]),
    );
    if (!staged) {
      // restore --workdir alone keeps the index; re-stage to mirror
      // `git restore` (workdir <- stage) only when source was HEAD... the
      // files were just written from HEAD, so stage them for consistency.
      for (const r of matched) {
        try {
          await git.add({ fs, dir: DIR, filepath: r[0] });
        } catch {
          /* best effort */
        }
      }
    }
  }
}

async function cmdReset(args: string[]): Promise<void> {
  await ensureRepo("reset");
  let mode: "soft" | "mixed" | "hard" = "mixed";
  let ref = "HEAD";
  const paths: string[] = [];
  let endOfOpts = false;
  for (const a of args) {
    if (!endOfOpts && a === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && a === "--soft") {
      mode = "soft";
      continue;
    }
    if (!endOfOpts && (a === "--mixed" || a === "--hard")) {
      mode = a.slice(2) as "mixed" | "hard";
      continue;
    }
    if (!endOfOpts && a.startsWith("-")) fail(129, `option '${a}' is not supported by the terminal shim`);
    if (!endOfOpts && paths.length === 0) {
      try {
        await resolveRevision(a);
        ref = a;
        continue;
      } catch {
        /* not a revision — treat as path */
      }
    }
    paths.push(normSpec(a));
  }
  if (paths.length > 0) {
    // Path mode: unstage (mixed semantics), like `git reset -- <path>`.
    const rows = await matrix();
    const matched = rows.filter((r) => paths.some((s) => specMatches(r[0], s)));
    if (matched.length === 0) fail(128, `error: pathspec '${paths[0]}' did not match any file(s)`);
    for (const r of matched) {
      await git.resetIndex({ fs, dir: DIR, filepath: r[0], ref });
    }
    return;
  }
  let oid: string;
  try {
    oid = await resolveRevision(ref);
  } catch {
    fail(128, `fatal: ambiguous argument '${ref}': unknown revision`);
  }
  const branch = await git.currentBranch({ fs, dir: DIR });
  if (!branch) fail(1, "reset from detached HEAD is not supported by the terminal shim");
  await git.writeRef({ fs, dir: DIR, ref: `refs/heads/${branch}`, value: oid!, force: true });
  if (mode === "soft") return;
  // mixed: reset index to ref.
  const rows = await matrix();
  for (const r of rows) {
    try {
      await git.resetIndex({ fs, dir: DIR, filepath: r[0], ref: oid });
    } catch {
      /* best effort per file */
    }
  }
  if (mode === "hard") {
    // Workdir <- ref for every tracked path; remove staged-new files.
    await restorePathsFromRef(
      oid!,
      rows.filter((r) => classify(r) !== "untracked").map((r) => r[0]),
    );
    for (const r of rows) {
      if (classify(r) === "added") {
        try {
          await fs.promises.rm(path.join(DIR, r[0]), { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }
}

function validateRemoteUrl(raw: string): string {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(128, `fatal: '${raw}' is not a valid remote URL`);
  }
  if (parsed!.protocol !== "https:") {
    fail(128, "terminal remotes must use https (no ssh, no local paths)");
  }
  if (parsed!.username || parsed!.password) {
    fail(128, "terminal remotes must not contain credentials; use Source Control for authenticated operations");
  }
  const host = parsed!.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) {
    fail(128, `terminal remotes are limited to ${ALLOWED_HOSTS.join(", ")} in this milestone`);
  }
  if (!/^\/[^/]+\/[^/]+?(\.git)?\/?$/.test(parsed!.pathname)) {
    fail(128, `fatal: '${raw}' does not look like an owner/repo URL`);
  }
  return url;
}

async function cmdRemote(args: string[]): Promise<void> {
  await ensureRepo("remote");
  if (args.length === 0) {
    const remotes = await git.listRemotes({ fs, dir: DIR });
    for (const r of remotes) say(r.remote);
    return;
  }
  if (args[0] === "-v" || args[0] === "--verbose") {
    const remotes = await git.listRemotes({ fs, dir: DIR });
    for (const r of remotes) {
      say(`${r.remote}\t${r.url} (fetch)`);
      say(`${r.remote}\t${r.url} (push)`);
    }
    return;
  }
  if (args[0] === "add") {
    const [, name, url] = args;
    if (!name || !url || args.length !== 3) fail(129, "usage: git remote add <name> <url>");
    const clean = validateRemoteUrl(url);
    try {
      await git.addRemote({ fs, dir: DIR, remote: name!, url: clean });
    } catch {
      fail(128, `error: remote ${name} already exists.`);
    }
    return;
  }
  if (args[0] === "remove" || args[0] === "rm") {
    const name = args[1];
    if (!name || args.length !== 2) fail(129, `usage: git remote remove <name>`);
    try {
      await git.deleteRemote({ fs, dir: DIR, remote: name });
    } catch {
      fail(128, `error: No such remote: '${name}'`);
    }
    return;
  }
  if (args[0] === "set-url") {
    const [, name, url] = args;
    if (!name || !url || args.length !== 3) fail(129, "usage: git remote set-url <name> <url>");
    const clean = validateRemoteUrl(url);
    try {
      await git.deleteRemote({ fs, dir: DIR, remote: name! });
    } catch {
      fail(128, `error: No such remote: '${name}'`);
    }
    await git.addRemote({ fs, dir: DIR, remote: name!, url: clean });
    return;
  }
  if (args[0] === "show") {
    fail(1, "remote inspection needs network access; remotes are managed read-only here — use Source Control for fetch/push.");
  }
  fail(129, `unknown subcommand '${args[0]}' (see 'git help')`);
}

async function cmdConfig(args: string[]): Promise<void> {
  await ensureRepo("config");
  if (args.length === 0 || args[0] === "--list" || args[0] === "-l") {
    for (const key of ["user.name", "user.email"]) {
      try {
        const v = await git.getConfig({ fs, dir: DIR, path: key });
        if (v) say(`${key}=${v}`);
      } catch {
        /* unset */
      }
    }
    const remotes = await git.listRemotes({ fs, dir: DIR });
    for (const r of remotes) say(`remote.${r.remote}.url=${r.url}`);
    return;
  }
  const key = args[0]!;
  if (key !== "user.name" && key !== "user.email") {
    fail(1, `only user.name and user.email are configurable in the terminal shim (got '${key}')`);
  }
  if (args.length === 1) {
    say((await git.getConfig({ fs, dir: DIR, path: key })) ?? "");
    return;
  }
  if (args.length === 2) {
    await git.setConfig({ fs, dir: DIR, path: key, value: args[1]! });
    return;
  }
  fail(129, "usage: git config user.name|user.email [value]");
}

function blockedRemote(sub: string): never {
  say(`Remote GitHub authentication is managed by Source Control.`);
  say(`Use the Source panel for authenticated ${sub}.`);
  say(`Terminal git is local to this project runtime.`);
  flush();
  process.exit(1);
}

/** Hidden plumbing: idempotent workspace snapshot (Strategy A). */
async function cmdEnsureSnapshot(): Promise<void> {
  if (await repoExists()) {
    say("terminal git ready (existing repository)");
    return;
  }
  await git.init({ fs, dir: DIR, defaultBranch: "main" });
  const rows = await matrix();
  for (const row of rows) {
    const top = row[0].split("/")[0]!;
    if (IGNORED_TOP.has(top)) continue;
    if (classify(row) === "untracked") {
      await git.add({ fs, dir: DIR, filepath: row[0] });
    }
  }
  const staged = (await matrix()).filter((r) => classify(r) === "added");
  if (staged.length > 0) {
    const id = await identity();
    await git.commit({
      fs,
      dir: DIR,
      message: "Initial workspace snapshot",
      author: { name: id.name, email: id.email },
    });
    say("terminal git ready (workspace snapshot committed on main)");
  } else {
    say("terminal git ready (empty repository on main)");
  }
}

/** Hidden plumbing: set origin to a validated non-secret URL (post Add Remote/Publish). */
async function cmdSyncRemote(args: string[]): Promise<void> {
  const url = args[0];
  if (!url) fail(129, "usage: __sync-remote <url>");
  if (!(await repoExists())) {
    say("terminal git has no local repository yet; remote will apply on init");
    return;
  }
  const clean = validateRemoteUrl(url);
  const remotes = await git.listRemotes({ fs, dir: DIR });
  if (remotes.some((r) => r.remote === "origin")) {
    await git.deleteRemote({ fs, dir: DIR, remote: "origin" });
  }
  await git.addRemote({ fs, dir: DIR, remote: "origin", url: clean });
  say(`origin -> ${clean}`);
}

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;
  if (!sub) {
    say("usage: git [-v | --version] [-h | --help] | <command> [<args>]");
    say("See 'git help' for available terminal commands.");
    flush();
    process.exit(1);
  } else if (sub === "-v" || sub === "--version") {
    await cmdVersion();
  } else if (sub === "-h" || sub === "--help" || sub === "help") {
    await cmdHelp();
  } else if (sub === "__ensure-snapshot") {
    await cmdEnsureSnapshot();
  } else if (sub === "__sync-remote") {
    await cmdSyncRemote(rest);
  } else if (sub === "init") {
    await cmdInit(rest);
  } else if (sub === "status") {
    await cmdStatus(rest);
  } else if (sub === "add") {
    await cmdAdd(rest);
  } else if (sub === "diff") {
    await cmdDiff(rest);
  } else if (sub === "commit") {
    await cmdCommit(rest);
  } else if (sub === "log") {
    await cmdLog(rest);
  } else if (sub === "branch") {
    await cmdBranch(rest);
  } else if (sub === "switch") {
    await cmdSwitch(rest);
  } else if (sub === "checkout") {
    await cmdCheckout(rest);
  } else if (sub === "restore") {
    await cmdRestore(rest);
  } else if (sub === "reset") {
    await cmdReset(rest);
  } else if (sub === "remote") {
    await cmdRemote(rest);
  } else if (sub === "config") {
    await cmdConfig(rest);
  } else if (sub === "fetch" || sub === "pull" || sub === "push") {
    blockedRemote(sub);
  } else if (sub === "clone") {
    say("Cloning from the terminal is disabled; import repositories through the GitHub panel.");
    say("Use the Source panel for authenticated fetch/pull/push.");
    flush();
    process.exit(1);
  } else if (sub === "merge" || sub === "rebase" || sub === "cherry-pick" || sub === "stash" || sub === "tag") {
    fail(1, `'git ${sub}' is not implemented in the terminal shim. Use Source Control where available.`);
  } else {
    fail(1, `git: '${sub}' is not supported by the terminal shim. See 'git help'.`);
  }
  flush();
}

main().catch((e) => {
  warn(e instanceof Error ? e.message : String(e));
  flush();
  process.exit(1);
}
);
