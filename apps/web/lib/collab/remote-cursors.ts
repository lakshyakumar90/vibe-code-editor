import type * as Monaco from "monaco-editor";
import type {
  EditorCursor,
  EditorSelectionRange,
} from "@repo/collab";

export interface RemotePeer {
  connectionId: string;
  displayName: string;
  cursor: EditorCursor;
  selection?: EditorSelectionRange | null;
}

/** Hue buckets — peers map to one by hashing their connection id. */
const COLOR_BUCKETS = 12;
const STYLE_ID = "collab-remote-cursors";

function bucketFor(connectionId: string): number {
  let hash = 0;
  for (let i = 0; i < connectionId.length; i++) {
    hash = (hash * 31 + connectionId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % COLOR_BUCKETS;
}

function ensureStyle(): void {
  if (typeof document === "undefined") {
    return;
  }
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  let css = "";
  for (let i = 0; i < COLOR_BUCKETS; i++) {
    const hue = Math.round((i * 360) / COLOR_BUCKETS);
    css +=
      `.rc-cursor-${i}{border-left:2px solid hsl(${hue},75%,45%);}` +
      `.rc-label-${i}{background:hsl(${hue},75%,45%);color:#fff;font-size:10px;` +
      `line-height:14px;padding:0 5px;border-radius:3px;margin-left:1px;` +
      `white-space:nowrap;}` +
      `.rc-sel-${i}{background:hsla(${hue},75%,50%,0.22);}`;
  }
  style.textContent = css;
  document.head.appendChild(style);
}

function clampPosition(
  model: Monaco.editor.ITextModel,
  cursor: EditorCursor,
): Monaco.Position {
  const lineCount = model.getLineCount();
  const lineNumber = Math.min(Math.max(1, cursor.lineNumber), lineCount);
  const maxColumn = model.getLineMaxColumn(lineNumber);
  return {
    lineNumber,
    column: Math.min(Math.max(1, cursor.column), maxColumn),
  } as Monaco.Position;
}

function clampRange(
  model: Monaco.editor.ITextModel,
  monaco: typeof Monaco,
  selection: EditorSelectionRange,
): Monaco.Range {
  const start = clampPosition(model, {
    lineNumber: selection.startLineNumber,
    column: selection.startColumn,
  });
  const end = clampPosition(model, {
    lineNumber: selection.endLineNumber,
    column: selection.endColumn,
  });
  return new monaco.Range(
    start.lineNumber,
    start.column,
    end.lineNumber,
    end.column,
  );
}

/**
 * Ephemeral remote cursors/selections for the ACTIVE file only.
 * Content is never modified — decorations render only. Uses a single
 * `createDecorationsCollection()` (no per-keystroke rebuild churn).
 */
export class RemoteCursorRenderer {
  private collection: Monaco.editor.IEditorDecorationsCollection | null = null;
  private monaco: typeof Monaco | null = null;
  private model: Monaco.editor.ITextModel | null = null;
  private peers = new Map<string, RemotePeer>();

  attach(
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
    model: Monaco.editor.ITextModel,
  ): void {
    ensureStyle();
    this.disposeCollection();
    this.monaco = monaco;
    this.model = model;
    this.collection = editor.createDecorationsCollection();
    this.render();
  }

  detach(): void {
    this.disposeCollection();
    this.monaco = null;
    this.model = null;
  }

  /** Replace the full peer set (already filtered to the active file). */
  setPeers(peers: RemotePeer[]): void {
    this.peers = new Map(peers.map((p) => [p.connectionId, p]));
    this.render();
  }

  removePeer(connectionId: string): void {
    if (this.peers.delete(connectionId)) {
      this.render();
    }
  }

  clear(): void {
    if (this.peers.size > 0) {
      this.peers.clear();
      this.render();
    }
  }

  dispose(): void {
    this.peers.clear();
    this.disposeCollection();
    this.monaco = null;
    this.model = null;
  }

  // -- internals ------------------------------------------------------------

  private disposeCollection(): void {
    try {
      this.collection?.clear();
    } catch {
      // already disposed with the editor
    }
    this.collection = null;
  }

  private render(): void {
    const collection = this.collection;
    const monaco = this.monaco;
    const model = this.model;
    if (!collection || !monaco || !model) {
      return;
    }
    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const peer of this.peers.values()) {
      const bucket = bucketFor(peer.connectionId);
      const pos = clampPosition(model, peer.cursor);
      decorations.push({
        range: new monaco.Range(
          pos.lineNumber,
          pos.column,
          pos.lineNumber,
          pos.column,
        ),
        options: {
          className: `rc-cursor-${bucket}`,
          hoverMessage: { value: peer.displayName },
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          after: {
            content: ` ${peer.displayName}`,
            inlineClassName: `rc-label-${bucket}`,
          },
        },
      });
      if (peer.selection) {
        const range = clampRange(model, monaco, peer.selection);
        if (!range.isEmpty()) {
          decorations.push({
            range,
            options: {
              className: `rc-sel-${bucket}`,
              stickiness:
                monaco.editor.TrackedRangeStickiness
                  .NeverGrowsWhenTypingAtEdges,
            },
          });
        }
      }
    }
    collection.set(decorations);
  }
}
