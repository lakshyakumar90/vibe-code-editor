import { auth } from "./auth";

export interface CollabSessionUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface ResolvedSession {
  user: CollabSessionUser;
  session: unknown;
}

/**
 * Shared session resolver for HTTP middleware AND the WebSocket upgrade path.
 * Accepts Node-style headers (Express `req.headers` or WS upgrade `req.headers`)
 * and returns the Better Auth session, or null when unauthenticated.
 * Never throws — callers treat null as 401 / connection reject.
 */
export async function resolveSessionFromHeaders(
  headersLike: Record<string, string | string[] | undefined>,
): Promise<ResolvedSession | null> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(headersLike)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          headers.append(key, item);
        }
      }
    } else {
      headers.set(key, value);
    }
  }

  // Better Auth reads the session from the cookie header (session token
  // row + 5-min signed cookie cache). No cookies -> unauthenticated.
  if (!headers.has("cookie")) {
    return null;
  }

  try {
    const session = await auth.api.getSession({ headers });
    if (!session?.user) {
      return null;
    }
    return session as unknown as ResolvedSession;
  } catch {
    return null;
  }
}
