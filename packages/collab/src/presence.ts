import type { Presence } from "./protocol.js";

/**
 * Pure in-memory presence + room membership store.
 * No sockets, no timers — fully unit-testable.
 * The gateway owns one instance and adds networking around it.
 */
export class PresenceStore {
  private rooms = new Map<string, Map<string, Presence>>();
  private connectionProjects = new Map<string, Set<string>>();

  /** Insert or replace the presence entry for a connection in a project. */
  upsert(presence: Presence): Presence {
    let room = this.rooms.get(presence.projectId);
    if (!room) {
      room = new Map();
      this.rooms.set(presence.projectId, room);
    }
    room.set(presence.connectionId, presence);
    let projects = this.connectionProjects.get(presence.connectionId);
    if (!projects) {
      projects = new Set();
      this.connectionProjects.set(presence.connectionId, projects);
    }
    projects.add(presence.projectId);
    return presence;
  }

  /** Remove one connection from one project. Returns the removed entry. */
  leave(projectId: string, connectionId: string): Presence | undefined {
    const room = this.rooms.get(projectId);
    const removed = room?.get(connectionId);
    room?.delete(connectionId);
    if (room && room.size === 0) {
      this.rooms.delete(projectId);
    }
    const projects = this.connectionProjects.get(connectionId);
    projects?.delete(projectId);
    if (projects && projects.size === 0) {
      this.connectionProjects.delete(connectionId);
    }
    return removed;
  }

  /**
   * Remove a connection from every project it joined.
   * Returns all removed entries so the caller can broadcast removals.
   */
  removeConnection(connectionId: string): Presence[] {
    const projects = this.connectionProjects.get(connectionId);
    if (!projects || projects.size === 0) {
      return [];
    }
    const removed: Presence[] = [];
    for (const projectId of [...projects]) {
      const entry = this.leave(projectId, connectionId);
      if (entry) {
        removed.push(entry);
      }
    }
    return removed;
  }

  /** Snapshot of all occupants in a project room. */
  list(projectId: string): Presence[] {
    return [...(this.rooms.get(projectId)?.values() ?? [])];
  }

  /** Projects a connection has currently joined. */
  projectsOf(connectionId: string): string[] {
    return [...(this.connectionProjects.get(connectionId) ?? [])];
  }

  /** Whether a connection is a member of a project room. */
  has(connectionId: string, projectId: string): boolean {
    return this.connectionProjects.get(connectionId)?.has(projectId) ?? false;
  }

  get(connectionId: string, projectId: string): Presence | undefined {
    return this.rooms.get(projectId)?.get(connectionId);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  connectionCount(): number {
    return this.connectionProjects.size;
  }
}
