import * as Y from "yjs";
import type * as Monaco from "monaco-editor";

/**
 * Mutual-exclusion helper for the bidirectional binding below.
 * Semantics copied from `lib0/mutex` (MIT © Kevin Jahns): while the mutex
 * is held, nested calls are dropped instead of run — this is what stops
 * remote-applied model edits from re-entering Y as local ops.
 */
function createMutex() {
  let token = true;
  return (f: () => void) => {
    if (token) {
      token = false;
      try {
        f();
      } finally {
        token = true;
      }
    }
  };
}

/**
 * Monaco ↔ Y.Text binding.
 *
 * Adapted from `y-monaco` v0.1.6 (MIT © Kevin Jahns, https://github.com/yjs/y-monaco).
 * Two deliberate changes for this codebase:
 * 1. The `monaco` instance is injected instead of importing the deep path
 *    `monaco-editor/esm/vs/editor/editor.api.js`, which does not resolve
 *    under this repo's pnpm + Turbopack setup.
 * 2. y-protocols awareness (remote cursor rendering) is dropped — cursor /
 *    selection presence uses our own server-attached protocol rendered by
 *    `remote-cursors.ts`, so `y-protocols` is not a dependency.
 *
 * Preserved semantics:
 * - A mutex serializes both directions, so remote-applied model edits
 *   never re-enter Y (no feedback loops / echo).
 * - Local cursor/selection is saved as Y relative positions before every
 *   transaction and restored after, so remote edits don't yank the caret.
 * - The model is aligned to `ytext` on attach when they differ.
 * - Remote ops land via `model.applyEdits` (native undo stack, no
 *   Y.UndoManager — see the undo decision in the Phase 2 report).
 */

interface RelativeSelection {
  start: Y.RelativePosition;
  end: Y.RelativePosition;
  direction: Monaco.SelectionDirection;
}

function createRelativeSelection(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monacoModel: Monaco.editor.ITextModel,
  type: Y.Text,
): RelativeSelection | null {
  const sel = editor.getSelection();
  if (sel !== null) {
    const startPos = sel.getStartPosition();
    const endPos = sel.getEndPosition();
    const start = Y.createRelativePositionFromTypeIndex(
      type,
      monacoModel.getOffsetAt(startPos),
    );
    const end = Y.createRelativePositionFromTypeIndex(
      type,
      monacoModel.getOffsetAt(endPos),
    );
    return { start, end, direction: sel.getDirection() };
  }
  return null;
}

export interface YjsMonacoBindingHandle {
  destroy(): void;
}

/**
 * Bind `ytext` to a live model for the given editors (normally one).
 * The caller must ensure `ytext` already holds converged state; any
 * residual difference is resolved model := ytext before listening starts.
 */
export class YjsMonacoBinding {
  private doc: Y.Doc;
  private ytext: Y.Text;
  private monacoModel: Monaco.editor.ITextModel;
  private editors: Set<Monaco.editor.IStandaloneCodeEditor>;
  private mux = createMutex();
  private savedSelections = new Map<
    Monaco.editor.IStandaloneCodeEditor,
    RelativeSelection
  >();
  private monacoChangeHandler: Monaco.IDisposable;
  private monacoDisposeHandler: Monaco.IDisposable;
  private ytextObserver: (event: Y.YTextEvent) => void;
  private beforeTransaction: () => void;
  private destroyed = false;

  constructor(
    monaco: typeof Monaco,
    ytext: Y.Text,
    monacoModel: Monaco.editor.ITextModel,
    editors: Set<Monaco.editor.IStandaloneCodeEditor> = new Set(),
  ) {
    this.doc = ytext.doc as Y.Doc;
    this.ytext = ytext;
    this.monacoModel = monacoModel;
    this.editors = editors;

    this.beforeTransaction = () => {
      this.mux(() => {
        this.savedSelections = new Map();
        editors.forEach((editor) => {
          if (editor.getModel() === monacoModel) {
            const rsel = createRelativeSelection(editor, monacoModel, ytext);
            if (rsel !== null) {
              this.savedSelections.set(editor, rsel);
            }
          }
        });
      });
    };
    this.doc.on("beforeAllTransactions", this.beforeTransaction);

    this.ytextObserver = (event: Y.YTextEvent) => {
      this.mux(() => {
        let index = 0;
        event.delta.forEach((op) => {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (op.insert !== undefined) {
            const pos = monacoModel.getPositionAt(index);
            const range = new monaco.Selection(
              pos.lineNumber,
              pos.column,
              pos.lineNumber,
              pos.column,
            );
            monacoModel.applyEdits([{ range, text: op.insert as string }]);
            index += (op.insert as string).length;
          } else if (op.delete !== undefined) {
            const pos = monacoModel.getPositionAt(index);
            const endPos = monacoModel.getPositionAt(index + op.delete);
            const range = new monaco.Selection(
              pos.lineNumber,
              pos.column,
              endPos.lineNumber,
              endPos.column,
            );
            monacoModel.applyEdits([{ range, text: "" }]);
          }
        });
        this.savedSelections.forEach((rsel, editor) => {
          const start = Y.createAbsolutePositionFromRelativePosition(
            rsel.start,
            this.doc,
          );
          const end = Y.createAbsolutePositionFromRelativePosition(
            rsel.end,
            this.doc,
          );
          if (
            start !== null &&
            end !== null &&
            start.type === ytext &&
            end.type === ytext
          ) {
            const model = editor.getModel();
            if (!model) {
              return;
            }
            const startPos = model.getPositionAt(start.index);
            const endPos = model.getPositionAt(end.index);
            editor.setSelection(
              monaco.Selection.createWithDirection(
                startPos.lineNumber,
                startPos.column,
                endPos.lineNumber,
                endPos.column,
                rsel.direction,
              ),
            );
          }
        });
      });
    };
    ytext.observe(this.ytextObserver);

    {
      const ytextValue = ytext.toString();
      if (monacoModel.getValue() !== ytextValue) {
        monacoModel.setValue(ytextValue);
      }
    }

    this.monacoChangeHandler = monacoModel.onDidChangeContent((event) => {
      this.mux(() => {
        this.doc.transact(() => {
          event.changes
            .slice()
            .sort((a, b) => b.rangeOffset - a.rangeOffset)
            .forEach((change) => {
              ytext.delete(change.rangeOffset, change.rangeLength);
              ytext.insert(change.rangeOffset, change.text);
            });
        }, this);
      });
    });

    this.monacoDisposeHandler = monacoModel.onWillDispose(() => {
      this.destroy();
    });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    try {
      this.monacoChangeHandler.dispose();
    } catch {
      // already disposed
    }
    try {
      this.monacoDisposeHandler.dispose();
    } catch {
      // already disposed
    }
    this.ytext.unobserve(this.ytextObserver);
    this.doc.off("beforeAllTransactions", this.beforeTransaction);
  }
}

export interface ModelBinding {
  destroy(): void;
}

/**
 * Attach collaboration to a live model (see module doc for semantics).
 * Precondition: `ytext` already holds converged state; the model is
 * synced from it first so the constructor alignment is a no-op.
 */
export function attachModelBinding(
  monaco: typeof Monaco,
  ytext: Y.Text,
  model: Monaco.editor.ITextModel,
  editor: Monaco.editor.IStandaloneCodeEditor,
): ModelBinding {
  const target = ytext.toString();
  if (model.getValue() !== target) {
    // No binding exists yet: plain setValue reaches React state via the
    // normal onChange path without creating Y transactions or broadcasts.
    model.setValue(target);
  }
  const binding = new YjsMonacoBinding(monaco, ytext, model, new Set([editor]));
  return {
    destroy: () => binding.destroy(),
  };
}
