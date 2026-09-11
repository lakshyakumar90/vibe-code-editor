import { afterEach, describe, expect, it, vi } from "vitest";
import { emitFileTreeChanged, setFileTreeBroadcaster } from "./file.events";

/**
 * File-tree hint emitter: persistence must never break because of
 * realtime. Unwired → silent no-op. Throwing broadcaster → swallowed.
 */

afterEach(() => {
  setFileTreeBroadcaster(null);
});

describe("emitFileTreeChanged", () => {
  it("is a safe no-op when no broadcaster is wired", () => {
    expect(() => emitFileTreeChanged("p1")).not.toThrow();
  });

  it("delegates the exact hint payload when wired", () => {
    const spy = vi.fn();
    setFileTreeBroadcaster(spy);
    emitFileTreeChanged("p1");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("p1", {
      type: "file.tree.changed",
      projectId: "p1",
    });
  });

  it("never throws when the broadcaster throws", () => {
    setFileTreeBroadcaster(() => {
      throw new Error("socket dead");
    });
    expect(() => emitFileTreeChanged("p1")).not.toThrow();
  });

  it("ignores empty project ids", () => {
    const spy = vi.fn();
    setFileTreeBroadcaster(spy);
    emitFileTreeChanged("");
    expect(spy).not.toHaveBeenCalled();
  });
});
