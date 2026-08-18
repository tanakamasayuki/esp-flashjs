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
 * @typedef {object} DeviceState
 * @property {'disconnected'|'connecting'|'connected'} status
 * @property {import('./esp-flashjs.js').DeviceInfo|null} info
 * @property {boolean} usingStub
 * @property {string|null} error
 * @property {number} baudRate      What the user selected.
 * @property {number|null} linkBaudRate  What the link settled on, once connected.
 */

/**
 * @typedef {object} AppState
 * @property {DeviceState} device
 * @property {{size: number|null}} flash
 * @property {{table: import('./esp-flashjs.js').PartitionTable|null, source: 'device'|'file'|null}} partitions
 * @property {Map<string, 'erased'|'zeroed'|'data'|'unreadable'>} partitionStates
 * @property {{kind: 'partition'|'buffer'|'region'|null, id: string|null}} selection
 * @property {Map<string, Buffer>} buffers
 * @property {{tab: 'analyze'|'hex'|'diff'}} inspector
 * @property {{active: boolean, phase: string, done: number, total: number, cancel: (() => void)|null}} busy
 * @property {LogEntry[]} log
 * @property {object|null} dialog
 */

/** @returns {AppState} */
/**
 * The rates on offer: the conventional ladder from 115200 merged with the set
 * the Arduino IDE offers for boards whose serial port is a microcontroller
 * running bridge firmware — an M5 ATOM presents a CH552 that way, and such a
 * bridge implements a fixed table of rates that does not include 921600.
 * Offering only one of those sets strands the boards that need the other.
 *
 * Listed as one sorted run rather than grouped by bridge, because nothing here
 * can tell which bridge is on the other end: Web Serial exposes a USB id and
 * nothing more. A label the user cannot match to their board is not guidance.
 *
 * There is no ordering by reliability either, and none is implied. Measured on
 * one CH340 link, 460800 read 256 KB four times out of four while 250000,
 * 500000, 750000, 921600 and 1500000 all failed every attempt, and 115200
 * managed two. Which rate works is a property of the whole path — bridge,
 * cable, host — so the only honest presentation is the list, and the only
 * honest check is trying it.
 */
export const BAUD_RATES = Object.freeze([
  115200, 230400, 250000, 460800, 500000, 750000, 921600, 1500000,
]);

const BAUD_STORAGE_KEY = 'esp-flashjs.baudRate';

/** @returns {number} */
function loadBaudRate() {
  try {
    const stored = Number(globalThis.localStorage?.getItem(BAUD_STORAGE_KEY));
    return BAUD_RATES.includes(stored) ? stored : BAUD_RATES[0];
  } catch {
    // Private browsing and some embedded webviews throw on access alone.
    return BAUD_RATES[0];
  }
}

/** @param {number} baudRate */
export function rememberBaudRate(baudRate) {
  try {
    globalThis.localStorage?.setItem(BAUD_STORAGE_KEY, String(baudRate));
  } catch {
    // Not being able to remember it is not worth failing over.
  }
}

/** @returns {AppState} */
export function initialState() {
  return {
    device: {
      status: 'disconnected',
      info: null,
      usingStub: false,
      error: null,
      // What the user asked for, and what the link actually settled on. They
      // differ when a rate was tried and did not hold.
      baudRate: loadBaudRate(),
      linkBaudRate: null,
    },
    flash: { size: null },
    partitions: { table: null, source: null },
    partitionStates: new Map(),
    selection: { kind: null, id: null },
    buffers: new Map(),
    inspector: { tab: 'analyze' },
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
