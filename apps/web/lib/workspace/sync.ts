/**
 * Step 0 — fan-out contract only (wired in Step 6).
 *
 * Three sync paths stay independent:
 *   immediate          Monaco model  -> TS worker (diagnostics / IntelliSense)
 *   debounced ~400ms   workspace     -> container.fs.writeFile (HMR)
 *   debounced ~1500ms  workspace     -> PUT /files/:id (DB persistence)
 */

export interface SyncTargets {
  /** Immediate: update (or create) the stable Monaco model. */
  updateModel: (dbPath: string, content: string) => void;
  /** Debounced by caller: mirror into WebContainer FS. */
  writeContainer: (dbPath: string, content: string) => Promise<void>;
  /** Debounced by caller: persist to the API/DB. */
  persist: (dbPath: string, content: string) => Promise<void>;
}

/** No-op targets for tests / pre-runtime states. */
export function createNoopSyncTargets(): SyncTargets {
  return {
    updateModel: () => {},
    writeContainer: () => Promise.resolve(),
    persist: () => Promise.resolve(),
  };
}
