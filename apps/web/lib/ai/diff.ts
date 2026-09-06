import { api } from "@/lib/api";

/** One file diff from GET /api/ai/changeset/:id (server computes old/new). */
export interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  deleted: boolean;
  isFolder: boolean;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

interface ChangeSetPayload {
  changeSet: { id: string; status: string };
  diffs: FileDiff[];
}

interface ApplyPayload {
  changeSetId: string;
  status: "applied" | "pending";
  files: string[];
  remaining: string[];
}

interface RejectPayload {
  changeSetId: string;
  status: "rejected" | "pending";
  remaining?: string[];
}

/** Fetch a pending changeset with computed diffs for review. */
export async function fetchChangeSet(id: string): Promise<ChangeSetPayload> {
  const res = await api.get<Envelope<ChangeSetPayload>>(
    `/api/ai/changeset/${id}`,
  );
  return res.data;
}

/** Apply whole changeset (no paths) or a per-file subset. */
export async function applyChangeSet(
  id: string,
  paths?: string[],
): Promise<ApplyPayload> {
  const res = await api.post<Envelope<ApplyPayload>>(
    `/api/ai/changeset/${id}/apply`,
    paths ? { paths } : {},
  );
  return res.data;
}

/** Reject whole changeset (no paths) or drop a per-file subset. */
export async function rejectChangeSet(
  id: string,
  paths?: string[],
): Promise<RejectPayload> {
  const res = await api.post<Envelope<RejectPayload>>(
    `/api/ai/changeset/${id}/reject`,
    paths ? { paths } : {},
  );
  return res.data;
}
