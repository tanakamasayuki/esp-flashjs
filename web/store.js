// @ts-check
/**
 * Minimal observable store.
 *
 * Subscribers register a selector and are only called when its result changes,
 * which keeps components from re-rendering on unrelated updates.
 *
 * State holds multi-megabyte `Uint8Array`s, so updates are compared by
 * reference and never deep-cloned. Copying a 16 MB dump on every keystroke
 * would be the single most expensive thing the app does.
 */

/**
 * @template T
 * @typedef {(state: AppState) => T} Selector
 */

/**
 * @typedef {object} Buffer
 * @property {string} id
 * @property {string} key   Identity used to replace a re-read of the same region.
 * @property {string} name
 * @property {Uint8Array} data
 * @property {'device'|'file'} source
 * @property {number|null} address     Flash offset it came from, when known.
 * @property {string|null} partitionLabel
 * @property {import('./esp-flashjs.js').AnalysisResult|null} analysis
 */

/**
 * @typedef {object} LogEntry
 * @property {number} time
 * @property {'info'|'warn'|'error'} level
 * @property {string} code
 * @property {Record<string, unknown>} [params]
 */

/**
 * @typedef {object} AppState
 * @property {{status: 'disconnected'|'connecting'|'connected', info: import('./esp-flashjs.js').DeviceInfo|null, usingStub: boolean, error: string|null}} device
 * @property {{size: number|null}} flash
 * @property {{table: import('./esp-flashjs.js').PartitionTable|null, source: 'device'|'file'|null}} partitions
 * @property {Map<string, 'erased'|'zeroed'|'data'|'unreadable'>} partitionStates
 * @property {{kind: 'partition'|'buffer'|'gap'|null, id: string|null}} selection
 * @property {Map<string, Buffer>} buffers
 * @property {{tab: 'info'|'hex'|'analyze'|'edit'|'diff'}} inspector
 * @property {{active: boolean, phase: string, done: number, total: number, cancel: (() => void)|null}} busy
 * @property {LogEntry[]} log
 * @property {object|null} dialog
 */

/** @returns {AppState} */
export function initialState() {
  return {
    device: { status: 'disconnected', info: null, usingStub: false, error: null },
    flash: { size: null },
    partitions: { table: null, source: null },
    partitionStates: new Map(),
    selection: { kind: null, id: null },
    buffers: new Map(),
    inspector: { tab: 'info' },
    busy: { active: false, phase: '', done: 0, total: 0, cancel: null },
    log: [],
    dialog: null,
  };
}

/**
 * @param {AppState} [initial]
 */
export function createStore(initial = initialState()) {
  /** @type {AppState} */
  let state = initial;
  /** @type {Set<{selector: Selector<unknown>, callback: (value: any) => void, last: unknown}>} */
  const subscribers = new Set();

  return {
    /** @returns {AppState} */
    getState() {
      return state;
    },

    /**
     * Shallow-merges a patch and notifies affected subscribers.
     * @param {Partial<AppState>} patch
     */
    setState(patch) {
      state = { ...state, ...patch };
      for (const sub of subscribers) {
        const next = sub.selector(state);
        if (Object.is(next, sub.last)) continue;
        sub.last = next;
        sub.callback(next);
      }
    },

    /**
     * @template T
     * @param {Selector<T>} selector
     * @param {(value: T) => void} callback
     * @param {object} [options]
     * @param {boolean} [options.immediate] Fire once with the current value.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(selector, callback, { immediate = false } = {}) {
      const entry = {
        selector: /** @type {Selector<unknown>} */ (selector),
        callback,
        last: selector(state),
      };
      subscribers.add(entry);
      if (immediate) callback(/** @type {T} */ (entry.last));
      return () => subscribers.delete(entry);
    },

    /**
     * Appends a log entry, keeping the list bounded.
     * @param {'info'|'warn'|'error'} level
     * @param {string} code
     * @param {Record<string, unknown>} [params]
     */
    log(level, code, params) {
      const entry = { time: Date.now(), level, code, params };
      // A long session can log thousands of protocol events; keeping the last
      // 500 is enough for a bug report and bounds memory.
      const log = [...state.log, entry].slice(-500);
      this.setState({ log });
    },
  };
}

/** @typedef {ReturnType<typeof createStore>} Store */

export const store = createStore();
