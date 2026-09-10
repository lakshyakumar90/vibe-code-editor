import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { anchorForOffset, offsetForAnchor } from "./awareness-rel";

function seededDoc(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  if (text.length > 0) {
    ytext.insert(0, text);
  }
  return { doc, ytext };
}

describe("awareness anchors", () => {
  it("round-trips an offset through anchor + resolve", () => {
    const { doc, ytext } = seededDoc("hello world");
    const anchor = anchorForOffset(ytext, 6);
    expect(anchor).not.toBeNull();
    expect(offsetForAnchor(ytext, doc, anchor)).toBe(6);
  });

  it("anchors doc start to the first item and resolves to 0", () => {
    const { doc, ytext } = seededDoc("hello");
    const anchor = anchorForOffset(ytext, 0);
    expect(anchor).not.toBeNull();
    expect(offsetForAnchor(ytext, doc, anchor)).toBe(0);
    expect(offsetForAnchor(ytext, doc, undefined)).toBeNull();
  });

  it("anchors doc end as null (0 when the doc is empty)", () => {
    const full = seededDoc("hello");
    expect(anchorForOffset(full.ytext, 5)).toBeNull();
    expect(offsetForAnchor(full.ytext, full.doc, null)).toBe(5);
    const empty = seededDoc("");
    expect(anchorForOffset(empty.ytext, 0)).toBeNull();
    expect(offsetForAnchor(empty.ytext, empty.doc, null)).toBe(0);
  });

  it("follows concurrent inserts (no 'one word behind')", () => {
    // A anchors offset 5 ("hello| world"); B concurrently inserts "XY" at
    // 0. Resolving A's anchor in the merged doc must track the text, not
    // the stale absolute offset.
    const a = seededDoc("hello world");
    const bDoc = new Y.Doc();
    const bText = bDoc.getText("content");
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(a.doc));

    const anchor = anchorForOffset(a.ytext, 5);
    bText.insert(0, "XY");

    // Merge both ways and resolve in the converged doc.
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(bDoc));
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(a.doc));
    expect(a.ytext.toString()).toBe(bText.toString());

    const resolved = offsetForAnchor(a.ytext, a.doc, anchor);
    expect(resolved).not.toBeNull();
    // The anchor sat between "hello" and " world" — it must still sit
    // there after the remote insert, i.e. offset 5 + 2.
    expect(a.ytext.toString().slice((resolved as number) - 5, resolved as number)).toBe(
      "hello",
    );
    expect(a.ytext.toString().slice(resolved as number, (resolved as number) + 6)).toBe(
      " world",
    );
  });

  it("returns null for anchors whose op is unknown locally", () => {
    const { doc, ytext } = seededDoc("hello");
    // Fabricated anchor: valid shape, unknown item id.
    const resolved = offsetForAnchor(ytext, doc, {
      client: 42424242,
      clock: 999,
      assoc: 0,
    });
    expect(resolved).toBeNull();
  });

  it("clamps out-of-range offsets when anchoring", () => {
    const { doc, ytext } = seededDoc("hi");
    const anchor = anchorForOffset(ytext, 10_000);
    expect(offsetForAnchor(ytext, doc, anchor)).toBe(2);
  });
});
