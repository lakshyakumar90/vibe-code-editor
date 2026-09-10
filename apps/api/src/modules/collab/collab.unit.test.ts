import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CollabGateway } from "./collab.gateway";
import type { GatewaySocket } from "./collab.gateway";
import type { ServerMessage } from "@repo/collab";

/** In-memory socket double driving the gateway without real TCP. */
class FakeSocket extends EventEmitter implements GatewaySocket {
  readonly readyState = 1;
  sent: ServerMessage[] = [];
  terminated = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }

  peerMessage(payload: unknown): void {
    this.emit(
      "message",
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
  }
}

const alice = { id: "u-alice", name: "Alice", email: "a@x.test", image: null };

function allowAll() {
  return async () => ({ ok: true }) as const;
}

function lastOfType<T extends ServerMessage["type"]>(
  socket: FakeSocket,
  type: T,
): Extract<ServerMessage, { type: T }> | undefined {
  const found = socket.sent.filter((m) => m.type === type);
  return found[found.length - 1] as
    | Extract<ServerMessage, { type: T }>
    | undefined;
}

describe("CollabGateway unit", () => {
  it("duplicate joins replace rather than duplicate presence", async () => {
    const gateway = new CollabGateway(allowAll());
    const socket = new FakeSocket();
    gateway.handleConnection(socket, alice);
    socket.peerMessage({ type: "project.join", projectId: "p1" });
    socket.peerMessage({ type: "project.join", projectId: "p1" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const joined = lastOfType(socket, "project.joined");
    expect(joined?.presence).toHaveLength(1);
    expect(gateway.connectionCount()).toBe(1);
  });

  it("sweepStale removes silent connections and notifies room members", async () => {
    let now = 1_000_000;
    const gateway = new CollabGateway(allowAll(), undefined, () => now);
    const aliceSocket = new FakeSocket();
    const bobSocket = new FakeSocket();
    gateway.handleConnection(aliceSocket, alice);
    gateway.handleConnection(bobSocket, {
      id: "u-bob",
      name: "Bob",
      email: "b@x.test",
      image: null,
    });
    aliceSocket.peerMessage({ type: "project.join", projectId: "p1" });
    bobSocket.peerMessage({ type: "project.join", projectId: "p1" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Both joined; now let Alice go silent past the stale timeout.
    now += 61_000;
    // Bob stays alive with a heartbeat ping.
    bobSocket.peerMessage({ type: "ping", ts: 1 });
    await new Promise((resolve) => setImmediate(resolve));

    const swept = gateway.sweepStale(now);
    expect(swept).toHaveLength(1);
    expect(aliceSocket.terminated).toBe(true);
    expect(bobSocket.terminated).toBe(false);

    const removed = lastOfType(bobSocket, "presence.removed");
    expect(removed?.userId).toBe("u-alice");
    expect(removed?.projectId).toBe("p1");
  });

  it("custom handlers extend the gateway for future phases", async () => {
    const gateway = new CollabGateway(allowAll());
    const received: unknown[] = [];
    gateway.registerHandler("editor.update", (_conn, message) => {
      received.push(message);
    });
    const socket = new FakeSocket();
    gateway.handleConnection(socket, alice);
    socket.peerMessage({ type: "editor.update", file: "a.ts" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(1);

    // Unregistered unknown types still error out.
    socket.peerMessage({ type: "terminal.hijack" });
    await new Promise((resolve) => setImmediate(resolve));
    const error = lastOfType(socket, "error");
    expect(error?.code).toBe("MALFORMED");
  });
});
