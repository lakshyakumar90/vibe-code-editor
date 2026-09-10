import * as Y from "yjs";
import type { EditorRelAnchor } from "@repo/collab";

/**
 * Yjs-anchored cursor positions for awareness.
 *
 * Absolute line/column races concurrent text edits (the position is
 * captured against doc version N but rendered against version N±1, so a
 * cursor lands "one word behind"). Anchoring to a Yjs item id makes the
 * position follow the text it points at; the receiver resolves it against
 * its own doc and falls back to the absolute position when the anchor
 * op hasn't arrived yet.
 */

/** Anchor a model offset to the shared text. Null = doc end (0 when empty). */
export function anchorForOffset(
  text: Y.Text,
  offset: number,
): EditorRelAnchor | null {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const rel = Y.createRelativePositionFromTypeIndex(text, clamped);
  if (rel.item === null) {
    return null;
  }
  return {
    client: rel.item.client,
    clock: rel.item.clock,
    assoc: rel.assoc,
    ...(typeof rel.tname === "string" ? { tname: rel.tname } : {}),
  };
}

/**
 * Resolve an anchor to an offset in the local doc. Returns null when the
 * anchor op is unknown locally (concurrent update still in flight) —
 * callers fall back to the absolute line/column and retry on the next
 * doc update.
 */
export function offsetForAnchor(
  text: Y.Text,
  doc: Y.Doc,
  anchor: EditorRelAnchor | null | undefined,
): number | null {
  if (anchor === undefined) {
    return null;
  }
  if (anchor === null) {
    // Yjs uses a null item for end-of-doc anchors (0 in an empty doc).
    return text.length;
  }
  let abs: { type: unknown; index: number } | null;
  try {
    // Rebuilt from wire fields; `type` re-attached to the local text.
    const rpos = {
      type: text,
      tname: anchor.tname ?? null,
      item: new Y.ID(anchor.client, anchor.clock),
      assoc: anchor.assoc,
    } as unknown as Y.RelativePosition;
    abs = Y.createAbsolutePositionFromRelativePosition(
      rpos,
      doc,
    ) as { type: unknown; index: number } | null;
  } catch {
    return null;
  }
  if (!abs || abs.type !== (text as unknown)) {
    return null;
  }
  return abs.index;
}
