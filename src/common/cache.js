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
 *   what the entry's refresh schedule follows. Null on an entry that is not an
 *   advisory and on one whose record named no state.
 * @property {number} [jitterMs] How much longer than the table's threshold this
 *   entry waits to be refreshed, milliseconds, drawn once when the entry was
 *   written. Absent on an entry written before entries carried a draw, which
 *   waits the plain threshold the table names.
 * @property {number} [misses] How many times in a row GitHub has answered 404
 *   for this advisory. Absent on an entry no read has missed.
 */

/**
 * @typedef {object} CacheOptions
 * @property {CacheStorage | null} [storage] The storage to read and write, and
 *   absent to use the one {@link storageOf} names.
 * @property {number} [at] The moment being asked about, epoch milliseconds. On
 *   a read it is the moment staleness is judged at, and on a write it is the
 *   time of the observation. Absent, the clock says.
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
   * How long an entry may go unrefreshed before a pass fetches it again, where
   * nothing named a state.
   *
   * Reaching it is not an end. A six-day-old triage entry is stale and still
   * held: the table paints from it while the queue refetches it.
   */
  const STALE_MS = 5 * MINUTE_MS;

  /**
   * How long an entry may go unrefreshed, by the state of the advisory it
   * holds.
   *
   * A triage or draft advisory is what a maintainer is working, so it refreshes
   * on the timescale of a page visit. A closed or published one does not change
   * often, and the REQUIREMENTS.md section 10 corpus is roughly 110 of them: on
   * one five-minute threshold, opening the done view twice in an afternoon
   * re-reads the whole corpus twice at a request a second.
   *
   * @type {Readonly<Record<string, number>>}
   */
  const STALE_MS_BY_STATE = {
    triage: 5 * MINUTE_MS,
    draft: 5 * MINUTE_MS,
    closed: 7 * DAY_MS,
    published: 30 * DAY_MS,
    withdrawn: 30 * DAY_MS,
  };

  /**
   * The most a draw puts off a refresh.
   *
   * REQUIREMENTS.md section 10 reads a corpus at one request per second, so the
   * entries a pass writes are stamped within minutes of each other. On one
   * shared threshold they fall due together and the corpus re-crawls in one
   * wave. Spread over five days it is a few advisories a day, which is what
   * background refreshing already costs.
   */
  const JITTER_MS = 5 * DAY_MS;

  /**
   * The states whose entries carry a draw: the two on the thirty-day threshold,
   * which are the ones a pass writes in bulk. A triage, draft, or closed entry
   * comes due within a week and has no herd to spread.
   *
   * @type {ReadonlySet<string>}
   */
  const JITTERED_STATES = new Set(['published', 'withdrawn']);

  /**
   * How many 404 answers in a row take an advisory's entry out.
   * REQUIREMENTS.md section 2 evicts an entry when its advisory no longer
   * exists, and an advisory GitHub no longer serves is that.
   *
   * One 404 is not enough. GitHub answers 404 for an advisory a maintainer has
   * lost access to and for one behind a bad minute, and the count resets on any
   * read that succeeds, so an entry is only taken after three passes have each
   * asked and each been told the advisory is not there.
   *
   * `crawl.js` counts three the same way for a list page that will not answer.
   * The number is written again here and not read from there: `crawl.js`
   * already reads this file, in the manifest's content script order and under
   * Node, so reading it back would be a cycle.
   */
  const MAX_MISSES = 3;

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
   * The randomness a caller put in place of `Math.random`, and null while
   * `Math.random` is what to draw from.
   *
   * @type {(() => number) | null}
   */
  let injectedRandom = null;

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
   * @param {(() => number) | null} source Draws a fraction in [0, 1), and null
   *   to go back to `Math.random`. The jitter is the only draw this file makes,
   *   so a test that pins this pins an entry's expiry to the millisecond.
   * @returns {void}
   */
  function setRandom(source) {
    injectedRandom = source;
  }

  /** @returns {number} a fraction in [0, 1). */
  function random() {
    return injectedRandom === null ? Math.random() : injectedRandom();
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
   * @param {string | null} state The entry's state, already normalized.
   * @param {unknown} value The draw the entry carries.
   * @returns {number} how much that draw puts off the entry's refresh,
   *   milliseconds. It is none where the state takes no draw, and it is held
   *   inside the range the table allows: an entry carrying a duration that is
   *   not a real one takes none, because every comparison against one answers
   *   false and the entry would never come due.
   */
  function jitterOf(state, value) {
    if (state === null || !JITTERED_STATES.has(state)) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.min(Math.max(0, value), JITTER_MS);
  }

  /**
   * @param {string | null} state The entry's state, already normalized.
   * @returns {number} the draw to store on an entry being written now, drawn
   *   here and never again. Drawn at read time the same entry would come due at
   *   a different moment on every read, and would be refreshed early or late
   *   depending on when someone looked.
   */
  function drawJitter(state) {
    return Math.floor(jitterOf(state, random() * JITTER_MS));
  }

  /**
   * @param {string | null | undefined} state
   * @param {number} [jitterMs] The draw the entry carries, and absent where the
   *   caller is asking about a state and not about an entry.
   * @returns {number} how long an entry in this state may go unrefreshed, its
   *   own draw included. An entry whose state this extension could not read
   *   takes the shortest threshold in the table.
   */
  function staleAfter(state, jitterMs) {
    const key = normalizeState(state);
    const held = key === null ? undefined : STALE_MS_BY_STATE[key];
    return (held === undefined ? STALE_MS : held) + jitterOf(key, jitterMs);
  }

  /**
   * @param {CacheEntry} entry
   * @param {number} at The instant the read is being made at.
   * @returns {number} how long ago the entry was observed, in milliseconds. An
   *   entry observed later than `at`, which a clock moved backwards produces,
   *   reads as age zero and is not stale.
   */
  function ageOf(entry, at) {
    return Math.max(0, at - entry.observedAt);
  }

  /**
   * @param {CacheEntry} entry
   * @param {number} at The instant the read is being made at.
   * @returns {boolean} whether the entry is old enough to be refreshed. An entry
   *   observed within its state's threshold, its own draw included, is not.
   *   Being stale is not being gone: the entry is shown while its refresh runs.
   */
  function isStale(entry, at) {
    return ageOf(entry, at) >= staleAfter(entry.state, entry.jitterMs);
  }

  /**
   * @param {unknown} value The miss count an entry carries.
   * @returns {number} how many reads in a row have missed, as a whole count. A
   *   count that is not a real one is none, so an entry carrying it is asked
   *   for three more times before it is taken and never taken on the first.
   */
  function missesOf(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
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
    const state = normalizeState(value.state);
    return {
      record: value.record,
      observedAt,
      state,
      jitterMs: jitterOf(state, value.jitterMs),
      misses: missesOf(value.misses),
    };
  }

  /**
   * Takes entries out of storage. Failing costs the caller nothing: the entry
   * stays, and the cache is rederivable either way.
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
      // The entry stays until whatever asked for this asks again.
    }
  }

  /**
   * Reads one entry. Age alone never takes one away: an entry is answered with
   * however old it is, and {@link isStale} is what says a refresh is due.
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
    return entryFrom(held);
  }

  /**
   * Reads many entries in one call, which is what the list table's first paint
   * takes.
   *
   * @param {readonly (string | null)[]} keys
   * @param {CacheOptions} [options]
   * @returns {Promise<Map<string, CacheEntry>>} the entries that are held, by
   *   key. A key with no entry is absent from the map.
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
    for (const key of wanted) {
      const entry = entryFrom(held[key]);
      if (entry !== null) found.set(key, entry);
    }
    return found;
  }

  /**
   * Writes one entry, stamped with the moment it was observed.
   *
   * The write puts the whole entry at that key, which is what takes any 404
   * count off it: a read that landed says the advisory is there, whatever the
   * reads before it said.
   *
   * @param {string | null} key
   * @param {unknown} record
   * @param {string | null} state The state the entry's refresh schedule
   *   follows. Only an advisory has one; a list and a progress entry carry null
   *   and take the plain threshold.
   * @param {CacheOptions} [options]
   * @returns {Promise<CacheEntry | null>} the entry as it was written, and null
   *   where nothing was written.
   */
  async function putEntry(key, record, state, options = {}) {
    const storage = options.storage ?? storageOf();
    if (storage === null || key === null) return null;
    /** @type {CacheEntry} */
    const entry = {
      record,
      observedAt: options.at ?? now(),
      state,
      jitterMs: drawJitter(state),
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
    return putEntry(advisoryKey(ref), record, stateOf(record), options);
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
   * Counts one 404 against an advisory, and takes its entry once
   * {@link MAX_MISSES} of them have come in a row.
   *
   * Only a 404 reaches here. A timeout, a refused connection, a 5xx, and a
   * queue that was stopped are this extension failing to reach GitHub, and none
   * of them says the advisory is gone.
   *
   * The count goes on the entry beside the observation, and the observation is
   * left where it stands: an advisory that answered 404 was not read, so the
   * entry is no fresher for having been asked and the next pass asks again.
   *
   * @param {{ owner?: unknown, repo?: unknown, ghsaId?: unknown } | null | undefined} ref
   * @param {CacheOptions} [options]
   * @returns {Promise<{ misses: number, evicted: boolean }>} how many 404s in a
   *   row this advisory has now answered with, and whether that took its entry.
   *   An advisory the cache holds nothing for counts none: there is nothing to
   *   evict and nothing the count would go on.
   */
  async function noteMissing(ref, options = {}) {
    const storage = options.storage ?? storageOf();
    const key = advisoryKey(ref);
    if (storage === null || key === null) return { misses: 0, evicted: false };
    /** @type {unknown} */
    let held;
    try {
      held = (await storage.get(key))[key];
    } catch {
      return { misses: 0, evicted: false };
    }
    const entry = entryFrom(held);
    if (entry === null) return { misses: 0, evicted: false };
    const misses = missesOf(entry.misses) + 1;
    if (misses >= MAX_MISSES) {
      await discard(storage, [key]);
      return { misses, evicted: true };
    }
    try {
      await storage.set({ [key]: { ...entry, misses } });
    } catch {
      // The count is lost and the entry is not, so the advisory is asked for
      // again and taken a pass later than it would have been.
      return { misses, evicted: false };
    }
    return { misses, evicted: false };
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
    return putEntry(listKey(ref), record, null, options);
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
    return putEntry(progressKey(ref), progress, null, options);
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
    STALE_MS,
    setStorage,
    storageOf,
    setClock,
    now,
    setRandom,
    advisoryKey,
    listKey,
    progressKey,
    isCacheKey,
    stateOf,
    staleAfter,
    isStale,
    entryFrom,
    getEntry,
    getAdvisory,
    putAdvisory,
    getAdvisories,
    noteMissing,
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
