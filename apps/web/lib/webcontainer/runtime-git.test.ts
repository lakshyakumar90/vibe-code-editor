/**
 * Runtime seam tests with a mocked WebContainer (no browser needed).
 * Verifies the credential-isolation contract at the exact boundary the
 * reviewer flagged: whatever the host process env holds, the terminal git
 * spawn receives identity-only env — never tokens, DB URLs, or git auth.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  container: null as {
    spawnCalls: { cmd: string; args: string[]; options?: unknown }[];
    files: Map<string, string>;
    spawnImpl: (cmd: string, args: string[]) => {
      output: ReadableStream<string>;
      exit: Promise<number>;
      kill: () => void;
    };
  } | null,
}));

vi.mock("./client", () => ({
  getWebContainer: async () => {
    if (!mocks.container) throw new Error("no container");
    const c = mocks.container;
    return {
      spawn: async (cmd: string, args: string[], options?: unknown) => {
        c.spawnCalls.push({ cmd, args, options });
        return c.spawnImpl(cmd, args);
      },
      fs: {
        readFile: async (p: string) => {
          const v = c.files.get(p);
          if (v === undefined) throw new Error("ENOENT");
          return v;
        },
        writeFile: async (p: string, data: string) => {
          c.files.set(p, data);
        },
        mkdir: async () => undefined,
      },
    };
  },
  describeBootFailure: (e: unknown) => String(e),
  resetWebContainerCache: () => undefined,
}));

import { ProjectRuntime } from "./runtime";

function streamOf(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

function fakeContainer(shimSize = 0) {
  const files = new Map<string, string>();
  if (shimSize > 0) files.set(".vibe/git-shim.cjs", "x".repeat(shimSize));
  return {
    spawnCalls: [] as { cmd: string; args: string[]; options?: unknown }[],
    files,
    spawnImpl: (cmd: string, args: string[]) => {
      void cmd;
      void args;
      return {
        output: streamOf(""),
        exit: Promise.resolve(0),
        kill: () => undefined,
      };
    },
  };
}

describe("runTerminalGit credential isolation", () => {
  beforeEach(() => {
    mocks.container = fakeContainer();
    vi.unstubAllGlobals();
  });

  it("forwards identity-only env even when the host env holds secrets", async () => {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- test-only host env poisoning
    process.env["GITHUB_TOKEN"] = "ghp_host_secret";
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- test-only host env poisoning
    process.env["DATABASE_URL"] = "postgres://host_secret";
    const rt = new ProjectRuntime("REACT");
    // Pre-seed the shim so no fetch is needed.
    mocks.container!.files.set(".vibe/git-shim.cjs", "x".repeat(200_000));
    mocks.container!.spawnImpl = () => ({
      output: streamOf("[main abc1234] hi\n"),
      exit: Promise.resolve(0),
      kill: () => undefined,
    });
    await rt.runTerminalGit(["commit", "-m", "hi"], { name: "T", email: "t@x.com" });
    const spawn = mocks.container!.spawnCalls.at(-1)!;
    expect(spawn.cmd).toBe("node");
    const env = (spawn.options as { env?: Record<string, string> }).env ?? {};
    expect(env).toEqual({ VIBE_GIT_NAME: "T", VIBE_GIT_EMAIL: "t@x.com" });
    const blob = JSON.stringify(spawn.options);
    expect(blob).not.toContain("ghp_host_secret");
    expect(blob).not.toContain("host_secret");
    expect(blob).not.toContain("GITHUB_TOKEN");
    expect(blob).not.toContain("DATABASE_URL");
    expect(blob).not.toContain("GIT_CONFIG");
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- test cleanup
    delete process.env["GITHUB_TOKEN"];
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- test cleanup
    delete process.env["DATABASE_URL"];
  });

  it("delivers the shim from the safe static bundle (no secrets possible)", async () => {
    const rt = new ProjectRuntime("REACT");
    const bundleText = `vibe-shim${"y".repeat(200_000)}`;
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: true, text: async () => bundleText }),
    );
    await rt.ensureGitShim();
    expect(mocks.container!.files.get(".vibe/git-shim.cjs")).toBe(bundleText);
  });

  it("probeNativeGit reports native git when present, unavailable otherwise", async () => {
    const rt = new ProjectRuntime("REACT");
    mocks.container!.spawnImpl = () => ({
      output: streamOf("git version 2.44.0\n"),
      exit: Promise.resolve(0),
      kill: () => undefined,
    });
    const found = await rt.probeNativeGit(1000);
    expect(found).toEqual({ available: true, version: "git version 2.44.0" });

    const rt2 = new ProjectRuntime("REACT");
    mocks.container!.spawnImpl = () => {
      throw new Error("command not found");
    };
    const missing = await rt2.probeNativeGit(1000);
    expect(missing).toEqual({ available: false, version: null });
  });
});
