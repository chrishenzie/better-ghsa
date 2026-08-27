'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') {
  require('./storage.js');
  require('./schema.js');
}

/**
 * The part of `browser.storage.local` this file uses. `chrome.storage.local`
 * satisfies it too, and so does a stand-in a test hands to {@link setStorage}.
 *
 * `get(null)` answers with every entry the extension holds, which is what the
 * clear reads to find the keys that belong to the cache.
 *
 * @typedef {object} CacheStorage
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/**
 * One cache entry: what was read, and when it was read.
 *
 * The record is whatever the caller cached under that key, which is a parsed
 * advisory for an advisory entry, a parsed list for a list entry, and the
 * refresh queue's progress for a progress entry. It is data an older version of
 * this extension wrote, so a reader checks its shape and never assumes it.
 *
 * @typedef {object} CacheEntry
 * @property {unknown} record
 * @property {number} observedAt Epoch milliseconds.
 * @property {string | null} state The advisory's state, lowercased, which is
 *   what the entry's life follows. Null on an entry that is not an advisory and
 *   on one whose record named no state.
 */

/**
 * @typedef {object} CacheOptions
 * @property {CacheStorage | null} [storage] The storage to read and write, and
 *   absent to use the one {@link storageOf} names.
 * @property {number} [at] The moment being asked about, epoch milliseconds. On
 *   a read it is the moment life and staleness are judged at, and on a write it
 *   is the time of the observation. Absent, the clock says.
 * @property {string | null} [state] On a write, the state the entry's life
 *   follows, and absent to read it from the record.
 */

(() => {
  /** What an advisory entry's key begins with. */
  const ADVISORY_PREFIX = 'adv:';

  /** What a list page entry's key begins with. */
  const LIST_PREFIX = 'list:';

  /** What the refresh queue's progress entry's key begins with. */
  const PROGRESS_PREFIX = 'queue:';

  /**
   * Every prefix the cache owns. The clear takes the entries under these and
   * nothing else: `members` and `branches` are separate stores, they cost real
   * relearning, and neither is rederivable from one page.
   *
   * @type {readonly string[]}
   */
  const CACHE_PREFIXES = [ADVISORY_PREFIX, LIST_PREFIX, PROGRESS_PREFIX];

  const MINUTE_MS = 60 * 1000;
  const DAY_MS = 24 * 60 * MINUTE_MS;

  /**
   * How long an entry may go unrefreshed before a pass fetches it again.
   * REQUIREMENTS.md section 2: an entry observed within the last five minutes
   * is not re-fetched.
   *
   * This is not entry life. Life is when an entry is discarded, and it is days;
   * staleness is when an entry is refreshed, and it is minutes. A six-day-old
   * triage entry is stale and still held: the table paints from it while the
   * queue refetches it.
   */
  const STALE_MS = 5 * MINUTE_MS;

  /**
   * How long an entry lives, by the state of the advisory it holds. Null is
   * indefinite: a published or withdrawn advisory does not change again, so its
   * entry is re-read when the advisory is opened and never discarded on a
   * schedule.
   *
   * @type {Readonly<Record<string, number | null>>}
   */
  const LIFE_MS = {
    triage: 7 * DAY_MS,
    draft: 7 * DAY_MS,
    closed: 30 * DAY_MS,
    published: null,
    withdrawn: null,
  };

  /**
   * How long an entry lives when nothing named a state: the shortest life in
   * the table. An entry whose state this extension could not read does not
   * outlive an open advisory's.
   */
  const DEFAULT_LIFE_MS = 7 * DAY_MS;

  /**
   * The storage a caller put in place of the browser's, and null while the
   * browser's own is what to use.
   *
   * @type {CacheStorage | null}
   */
  let injected = null;

  /**
   * The clock a caller put in place of the wall clock, and null while the wall
   * clock is what to read.
   *
   * @type {(() => number) | null}
   */
  let injectedClock = null;

  /**
   * @returns {CacheStorage | null} `storage.local` under whichever name this
   *   browser gives the extension API, and null where there is none, which is
   *   every environment outside a browser. This is the one caller that evicts,
   *   so a store carrying no `remove` is not one it can use.
   */
  function browserStorage() {
    return /** @type {CacheStorage | null} */ (
      globalThis.bghsa.storage.local(['get', 'set', 'remove'])
    );
  }

  /**
   * @param {CacheStorage | null} storage The storage to use, and null to go back
   *   to the browser's own.
   * @returns {void}
   */
  function setStorage(storage) {
    injected = storage;
  }

  /** @returns {CacheStorage | null} the storage this file reads and writes. */
  function storageOf() {
    return injected ?? browserStorage();
  }

  /**
   * @param {(() => number) | null} clock The clock to read, and null to go back
   *   to the wall clock. Every threshold here is a duration in milliseconds, so
   *   a test moves time by moving this and waits for nothing.
   * @returns {void}
   */
  function setClock(clock) {
    injectedClock = clock;
  }

  /** @returns {number} the current moment, epoch milliseconds. */
  function now() {
    return injectedClock === null ? Date.now() : injectedClock();
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @returns {string | null} the repository as `owner/repo` lowercased, and null
   *   where the page did not say which repository it is. GitHub treats an owner
   *   and a repository name case-insensitively, so the key is folded and two
   *   spellings do not become two entries.
   */
  function repositoryOf(ref) {
    if (ref === null || ref === undefined) return null;
    const owner = String(ref.owner ?? '').trim().toLowerCase();
    const repo = String(ref.repo ?? '').trim().toLowerCase();
    return owner === '' || repo === '' ? null : `${owner}/${repo}`;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown, ghsaId?: unknown } | null | undefined} ref
   * @returns {string | null} the key one advisory's entry is held under,
   *   `adv:{owner}/{repo}:{ghsa}`, and null where the reference names no
   *   advisory. A GHSA identifier names one advisory whatever its case, so it is
   *   folded with the rest of the key.
   */
  function advisoryKey(ref) {
    const repository = repositoryOf(ref);
    const ghsa = String(ref?.ghsaId ?? '').trim().toLowerCase();
    return repository === null || ghsa === '' ? null : `${ADVISORY_PREFIX}${repository}:${ghsa}`;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @returns {string | null} the key one repository's list page entry is held
   *   under. The list entry is per repository for the same reason the advisory
   *   key carries the repository: a browser open on two repositories' advisory
   *   lists holds one entry for each.
   */
  function listKey(ref) {
    const repository = repositoryOf(ref);
    return repository === null ? null : `${LIST_PREFIX}${repository}`;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @returns {string | null} the key one repository's refresh progress is held
   *   under. A pass covers the advisories of one repository, so its progress is
   *   held per repository.
   */
  function progressKey(ref) {
    const repository = repositoryOf(ref);
    return repository === null ? null : `${PROGRESS_PREFIX}${repository}`;
  }

  /**
   * @param {unknown} key
   * @returns {boolean} whether this storage key belongs to the cache. The
   *   `members` and `branches` entries do not.
   */
  function isCacheKey(key) {
    return typeof key === 'string' && CACHE_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  /**
   * @param {unknown} value
   * @returns {string | null} the state as the life table names it, and null
   *   where there is none.
   */
  function normalizeState(value) {
    if (typeof value !== 'string') return null;
    const state = value.trim().toLowerCase();
    return state === '' ? null : state;
  }

  /**
   * @param {unknown} record
   * @returns {string | null} the state the record names, which is what the
   *   entry's life follows.
   */
  function stateOf(record) {
    if (!globalThis.bghsa.schema.isPlainObject(record)) return null;
    return normalizeState(record.state);
  }

  /**
   * @param {string | null | undefined} state
   * @returns {number | null} how long an entry in this state lives, and null
   *   where it lives indefinitely.
   */
  function lifeOf(state) {
    const key = normalizeState(state);
    if (key === null) return DEFAULT_LIFE_MS;
    const life = LIFE_MS[key];
    return life === undefined ? DEFAULT_LIFE_MS : life;
  }

  /**
   * @param {CacheEntry} entry
   * @param {number} [at]
   * @returns {number} how long ago the entry was observed, in milliseconds. An
   *   entry observed later than `at`, which a clock moved backwards produces,
   *   reads as age zero and is neither stale nor expired.
   */
  function ageOf(entry, at = now()) {
    return Math.max(0, at - entry.observedAt);
  }

  /**
   * @param {CacheEntry} entry
   * @param {number} [at]
   * @returns {boolean} whether the entry has outlived its state's life and is to
   *   be discarded.
   */
  function isExpired(entry, at = now()) {
    const life = lifeOf(entry.state);
    return life === null ? false : ageOf(entry, at) >= life;
  }

  /**
   * @param {CacheEntry} entry
   * @param {number} [at]
   * @returns {boolean} whether the entry is old enough to be refreshed. An entry
   *   observed within the last five minutes is not.
   */
  function isStale(entry, at = now()) {
    return ageOf(entry, at) >= STALE_MS;
  }

  /**
   * @param {unknown} value The entry as storage handed it back.
   * @returns {CacheEntry | null} the entry it holds, and null where it holds
   *   something else.
   */
  function entryFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const observedAt = value.observedAt;
    if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return null;
    return { record: value.record, observedAt, state: normalizeState(value.state) };
  }

  /**
   * Takes an expired entry out of storage. Failing costs the caller nothing: it
   * already read the entry as absent.
   *
   * @param {CacheStorage} storage
   * @param {string[]} keys
   * @returns {Promise<void>}
   */
  async function discard(storage, keys) {
    if (keys.length === 0) return;
    try {
      await storage.remove(keys);
    } catch {
      // The entry stays until the next read, which discards it again.
    }
  }

  /**
   * Reads one entry. An entry past its state's life is gone: it answers as
   * absent and is taken out of storage.
   *
   * The cache is never authoritative, so a storage failure is an absent entry
   * and not an error: the caller rederives what it needed from the page or from
   * a fetch.
   *
   * @param {string | null} key
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>}
   */
  async function getEntry(key, options = {}) {
    const storage = options.storage ?? storageOf();
    if (storage === null || key === null) return null;
    /** @type {unknown} */
    let held;
    try {
      held = (await storage.get(key))[key];
    } catch {
      return null;
    }
    const entry = entryFrom(held);
    if (entry === null) return null;
    if (isExpired(entry, options.at ?? now())) {
      await discard(storage, [key]);
      return null;
    }
    return entry;
  }

  /**
   * Reads many entries in one call, which is what the list table's first paint
   * takes.
   *
   * @param {readonly (string | null)[]} keys
   * @param {CacheOptions} [options]
   * @returns {Promise<Map<string, CacheEntry>>} the entries that are held and
   *   within their life, by key. A key with no entry is absent from the map.
   */
  async function getEntries(keys, options = {}) {
    const storage = options.storage ?? storageOf();
    /** @type {Map<string, CacheEntry>} */
    const found = new Map();
    const wanted = [...new Set(keys.filter((key) => typeof key === 'string'))];
    if (storage === null || wanted.length === 0) return found;
    /** @type {Record<string, unknown>} */
    let held;
    try {
      held = await storage.get(wanted);
    } catch {
      return found;
    }
    const at = options.at ?? now();
    /** @type {string[]} */
    const expired = [];
    for (const key of wanted) {
      const entry = entryFrom(held[key]);
      if (entry === null) continue;
      if (isExpired(entry, at)) {
        expired.push(key);
        continue;
      }
      found.set(key, entry);
    }
    await discard(storage, expired);
    return found;
  }

  /**
   * Writes one entry, stamped with the moment it was observed.
   *
   * @param {string | null} key
   * @param {unknown} record
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>} the entry as it was written, and null
   *   where nothing was written.
   */
  async function putEntry(key, record, options = {}) {
    const storage = options.storage ?? storageOf();
    if (storage === null || key === null) return null;
    /** @type {CacheEntry} */
    const entry = {
      record,
      observedAt: options.at ?? now(),
      state: options.state === undefined ? stateOf(record) : normalizeState(options.state),
    };
    try {
      await storage.set({ [key]: entry });
    } catch {
      return null;
    }
    return entry;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown, ghsaId?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>} what this extension last read of one
   *   advisory.
   */
  function getAdvisory(ref, options = {}) {
    return getEntry(advisoryKey(ref), options);
  }

  /**
   * Holds what was read of one advisory. Both paths that read an advisory land
   * here: a fetch by the refresh queue, and the live DOM of a detail page the
   * maintainer opened, which costs no request.
   *
   * @param {{ owner?: unknown, repo?: unknown, ghsaId?: unknown } | null | undefined} ref
   * @param {unknown} record The parsed advisory.
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>}
   */
  function putAdvisory(ref, record, options = {}) {
    return putEntry(advisoryKey(ref), record, options);
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref The
   *   repository the advisories are on.
   * @param {readonly string[]} ghsaIds
   * @param {CacheOptions} [options]
   * @returns {Promise<Map<string, CacheEntry>>} the entries held for those
   *   advisories, keyed by the GHSA identifier as the caller spelled it.
   */
  async function getAdvisories(ref, ghsaIds, options = {}) {
    /** @type {Map<string, string>} */
    const byKey = new Map();
    for (const ghsaId of ghsaIds) {
      const key = advisoryKey({ ...(ref ?? {}), ghsaId });
      if (key !== null && !byKey.has(key)) byKey.set(key, ghsaId);
    }
    const entries = await getEntries([...byKey.keys()], options);
    /** @type {Map<string, CacheEntry>} */
    const found = new Map();
    for (const [key, entry] of entries) {
      const ghsaId = byKey.get(key);
      if (ghsaId !== undefined) found.set(ghsaId, entry);
    }
    return found;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>} what this extension last read of one
   *   repository's list page.
   */
  function getList(ref, options = {}) {
    return getEntry(listKey(ref), options);
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {unknown} record The parsed list.
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>}
   */
  function putList(ref, record, options = {}) {
    return putEntry(listKey(ref), record, { ...options, state: options.state ?? null });
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<unknown>} the refresh queue's progress on this repository,
   *   and null where there is none to resume. The caller checks its shape.
   */
  async function getProgress(ref, options = {}) {
    const entry = await getEntry(progressKey(ref), options);
    return entry === null ? null : entry.record;
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {unknown} progress
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>}
   */
  function putProgress(ref, progress, options = {}) {
    return putEntry(progressKey(ref), progress, { ...options, state: options.state ?? null });
  }

  /**
   * @param {{ owner?: unknown, repo?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<void>} takes the progress entry away, which is what a
   *   finished pass leaves behind.
   */
  async function clearProgress(ref, options = {}) {
    const storage = options.storage ?? storageOf();
    const key = progressKey(ref);
    if (storage === null || key === null) return;
    await discard(storage, [key]);
  }

  /**
   * Empties the cache. Every entry it holds is rederivable from the advisories,
   * so this costs reads and nothing else.
   *
   * The `members` and `branches` entries are left alone. They are separate
   * stores under keys of their own, they accumulate across advisories and
   * sessions, and what they hold is not rederivable from any one page.
   *
   * @param {CacheOptions} [options]
   * @returns {Promise<number>} how many entries were taken.
   */
  async function clear(options = {}) {
    const storage = options.storage ?? storageOf();
    if (storage === null) return 0;
    /** @type {Record<string, unknown>} */
    let all;
    try {
      all = await storage.get(null);
    } catch {
      return 0;
    }
    const keys = Object.keys(all).filter(isCacheKey);
    if (keys.length === 0) return 0;
    try {
      await storage.remove(keys);
    } catch {
      return 0;
    }
    return keys.length;
  }

  const exported = {
    ADVISORY_PREFIX,
    LIST_PREFIX,
    PROGRESS_PREFIX,
    CACHE_PREFIXES,
    DAY_MS,
    STALE_MS,
    LIFE_MS,
    DEFAULT_LIFE_MS,
    setStorage,
    storageOf,
    setClock,
    now,
    advisoryKey,
    listKey,
    progressKey,
    isCacheKey,
    stateOf,
    lifeOf,
    ageOf,
    isExpired,
    isStale,
    entryFrom,
    getEntry,
    getEntries,
    putEntry,
    getAdvisory,
    putAdvisory,
    getAdvisories,
    getList,
    putList,
    getProgress,
    putProgress,
    clearProgress,
    clear,
  };

  globalThis.bghsa.cache = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
