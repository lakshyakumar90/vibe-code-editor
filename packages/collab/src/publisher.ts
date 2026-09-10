import type { ServerMessage } from "./protocol.js";

/**
 * Seam for future horizontal scaling (Phase 1: local only, no Redis).
 *
 * The gateway always delivers to local room members directly. When a
 * `remotePublisher` is configured, it additionally fans the message out
 * to other API instances; inbound cross-instance traffic re-enters via
 * `gateway.handleRemoteMessage(projectId, message)`.
 *
 * A future Redis implementation only needs:
 *   publish(projectId, message) -> redis.publish(`collab:${projectId}`, JSON)
 * plus a subscriber that calls `handleRemoteMessage` on receipt.
 * No protocol or gateway redesign required.
 */
export interface CollabPublisher {
  publish(projectId: string, message: ServerMessage): void;
}

/** No-op publisher used in unit tests. */
export class NullPublisher implements CollabPublisher {
  publish(): void {
    // intentional no-op
  }
}

/** Records published messages — useful for asserting fan-out in tests. */
export class RecordingPublisher implements CollabPublisher {
  readonly published: Array<{ projectId: string; message: ServerMessage }> =
    [];

  publish(projectId: string, message: ServerMessage): void {
    this.published.push({ projectId, message });
  }
}
