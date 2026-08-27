'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./cache.js');
  require('./schema.js');
  require('./parse-detail.js');
  require('./write.js');
}

/**
 * How far one pass has got. It is held in the cache, so a pass a navigation
 * interrupted resumes on the next page load. REQUIREMENTS.md section 12 leaves
 * the extension no background script, so nothing refreshes unless a `github.com`
 * tab is open and a pass has to survive the tab it started in going somewhere
 * else.
 *
 * @typedef {object} QueueProgress
 * @property {string[]} pending The advisories still to read, in the order they
 *   will be read.
 * @property {string | null} inFlight The advisory a request went out for and
 *   whose answer has not been taken into the cache.
 * @property {string[]} done The advisories this pass holds current data for,
 *   whether it fetched them or found them fresh.
 * @property {string[]} failed The advisories whose read failed this pass.
 * @property {number | null} lastRequestAt When the last request went out, epoch
 *   milliseconds. It outlives the page so a reload cannot spend a request
 *   sooner than one second after the one before it.
 * @property {number | null} startedAt When this pass began.
 * @property {number} updatedAt When this record was written.
 */

/**
 * The counts are what this queue has done since it was created, which is one
 * page load's worth of work.
 *
 * @typedef {object} QueueSummary
 * @property {number} fetched Advisories read over the network.
 * @property {number} skipped Advisories the cache already held within the
 *   staleness threshold, whether they were dropped when they were queued or
 *   when their turn came.
 * @property {number} failed Advisories whose read failed.
 * @property {string[]} remaining Advisories left when the pass returned, which
 *   is empty unless it was stopped.
 * @property {boolean} complete Whether the queue emptied.
 */

/**
 * @typedef {object} QueueOptions
 * @property {{ owner: string, repo: string }} ref The repository whose
 *   advisories this pass reads.
 * @property {import('./cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now] The clock, epoch milliseconds. Injected, so a
 *   test moves time without spending it.
 * @property {(ms: number) => Promise<void>} [wait] What the queue waits with
 *   between requests. Injected for the same reason.
 * @property {import('./write.js').WriteFetch} [fetch]
 * @property {(html: string, ref: import('./parse-detail.js').AdvisoryRef) => unknown} [parse]
 *   What turns a fetched page into the record the cache holds.
 * @property {(ghsaId: string, entry: import('./cache.js').CacheEntry) => void} [onEntry]
 *   Called for each advisory the pass has current data for, which is what
 *   updates a row in place.
 * @property {(ghsaId: string, reason: unknown) => void} [onFailure]
 */

(() => {
  /**
   * The shortest time between two requests. Every read on a repository goes
   * through one serial queue, so this is the rate for the repository and not the
   * rate for one caller.
   */
  const RATE_MS = 1000;

  /**
   * @param {unknown} value
   * @returns {boolean} whether this names an advisory.
   */
  function isGhsaId(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  /**
   * @param {unknown} value
   * @returns {string[]} the advisory identifiers the value holds, once each and
   *   in the order they were given.
   */
  function idsOf(value) {
    /** @type {string[]} */
    const ids = [];
    if (!Array.isArray(value)) return ids;
    for (const id of value) {
      if (!isGhsaId(id)) continue;
      const ghsaId = /** @type {string} */ (id).trim();
      if (!ids.includes(ghsaId)) ids.push(ghsaId);
    }
    return ids;
  }

  /**
   * @param {unknown} value
   * @returns {number | null}
   */
  function timeOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /**
   * @param {unknown} value The progress as the cache handed it back.
   * @returns {QueueProgress | null} the progress it holds, and null where it
   *   holds something else. The record is data an older version of this
   *   extension wrote, so its shape is checked and never assumed.
   */
  function progressFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const inFlight = isGhsaId(value.inFlight) ? /** @type {string} */ (value.inFlight).trim() : null;
    return {
      pending: idsOf(value.pending),
      inFlight,
      done: idsOf(value.done),
      failed: idsOf(value.failed),
      lastRequestAt: timeOf(value.lastRequestAt),
      startedAt: timeOf(value.startedAt),
      updatedAt: timeOf(value.updatedAt) ?? 0,
    };
  }

  /**
   * The order a pass reads advisories in, and the ones it does not read at all.
   *
   * Stalest first: an advisory this extension has never read comes before every
   * advisory it has, and older observations come before newer ones. Two
   * advisories observed at the same moment are ordered by identifier, so a pass
   * planned twice is planned the same way.
   *
   * An advisory observed within the staleness threshold is not read. That
   * threshold is five minutes and is not entry life: a six-day-old triage entry
   * is read again, and the table paints from it while that happens.
   *
   * @param {readonly string[]} ghsaIds
   * @param {Map<string, import('./cache.js').CacheEntry>} entries What the cache
   *   holds for those advisories.
   * @param {number} at
   * @returns {{ order: string[], fresh: string[] }}
   */
  function plan(ghsaIds, entries, at) {
    /** @type {string[]} */
    const order = [];
    /** @type {string[]} */
    const fresh = [];
    for (const ghsaId of idsOf([...ghsaIds])) {
      const entry = entries.get(ghsaId);
      if (entry !== undefined && !globalThis.bghsa.cache.isStale(entry, at)) {
        fresh.push(ghsaId);
        continue;
      }
      order.push(ghsaId);
    }
    order.sort((left, right) => {
      const first = entries.get(left);
      const second = entries.get(right);
      const one = first === undefined ? Number.NEGATIVE_INFINITY : first.observedAt;
      const two = second === undefined ? Number.NEGATIVE_INFINITY : second.observedAt;
      if (one !== two) return one - two;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return { order, fresh };
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * One serial refresh queue for one repository, at one request per second,
   * stalest first, with its progress held in the cache.
   *
   * The queue is created by a content script and runs while that page is open.
   * A page that goes away takes the pass with it; the next page load reads the
   * progress back and carries on.
   *
   * @param {QueueOptions} options
   */
  function createQueue(options) {
    const ref = { owner: String(options.ref.owner), repo: String(options.ref.repo) };
    const storage = options.storage;
    const clock = options.now ?? (() => globalThis.bghsa.cache.now());
    const wait = options.wait ?? sleep;
    const send =
      options.fetch ??
      /** @type {import('./write.js').WriteFetch} */ (globalThis.fetch.bind(globalThis));
    const parse =
      options.parse ??
      ((html) =>
        globalThis.bghsa.parseDetail.parseDetail(
          new DOMParser().parseFromString(html, 'text/html')
        ));

    /** @type {string[]} */
    let pending = [];
    /** @type {string | null} */
    let inFlight = null;
    /** @type {string[]} */
    let done = [];
    /** @type {string[]} */
    let failed = [];
    /** @type {number | null} */
    let lastRequestAt = null;
    /** @type {number | null} */
    let startedAt = null;
    /** @type {Promise<QueueSummary> | null} */
    let running = null;
    let stopped = false;
    let fetched = 0;
    let skipped = 0;
    let failures = 0;

    /** @returns {QueueProgress} how far this pass has got. */
    function progress() {
      return {
        pending: [...pending],
        inFlight,
        done: [...done],
        failed: [...failed],
        lastRequestAt,
        startedAt,
        updatedAt: clock(),
      };
    }

    /** @returns {Promise<void>} holds the progress where the next page reads it. */
    async function persist() {
      await globalThis.bghsa.cache.putProgress(ref, progress(), { storage, at: clock() });
    }

    /**
     * @param {string} ghsaId
     * @param {import('./cache.js').CacheEntry} entry
     * @returns {void}
     */
    function report(ghsaId, entry) {
      if (options.onEntry === undefined) return;
      try {
        options.onEntry(ghsaId, entry);
      } catch (error) {
        options.onFailure?.(ghsaId, error);
      }
    }

    /**
     * Reads what an earlier page left and carries on from it.
     *
     * The advisory that was in flight when that page went away is the one whose
     * request went out and whose answer never reached the cache. It goes back at
     * the head of the queue, so the pass loses no work. It is not counted done,
     * so nothing is double counted either, and where the answer did land before
     * the page went away the cache holds it and the staleness check takes it out
     * of the queue without spending a second request.
     *
     * @returns {Promise<QueueProgress | null>} what was resumed, and null where
     *   there was nothing to resume.
     */
    async function load() {
      const held = progressFrom(
        await globalThis.bghsa.cache.getProgress(ref, { storage, at: clock() })
      );
      if (held === null) return null;
      pending = idsOf(held.inFlight === null ? held.pending : [held.inFlight, ...held.pending]);
      inFlight = null;
      done = [...held.done];
      failed = [...held.failed];
      lastRequestAt = held.lastRequestAt;
      startedAt = held.startedAt;
      return held;
    }

    /**
     * Puts advisories in the queue, ordering everything queued stalest first and
     * dropping what the cache holds within the staleness threshold.
     *
     * @param {readonly string[]} ghsaIds
     * @returns {Promise<{ queued: string[], fresh: string[] }>}
     */
    async function add(ghsaIds) {
      const at = clock();
      const wanted = idsOf([...pending, ...ghsaIds]).filter((ghsaId) => ghsaId !== inFlight);
      const entries = await globalThis.bghsa.cache.getAdvisories(ref, wanted, { storage, at });
      const { order, fresh } = plan(wanted, entries, at);
      pending = order;
      for (const ghsaId of fresh) {
        if (done.includes(ghsaId)) continue;
        done.push(ghsaId);
        skipped += 1;
        const entry = entries.get(ghsaId);
        if (entry !== undefined) report(ghsaId, entry);
      }
      if (startedAt === null) startedAt = at;
      await persist();
      return { queued: [...pending], fresh };
    }

    /**
     * Fetches one advisory's detail page and holds what it says. Every derived
     * value comes from that one page, so one advisory costs one request.
     *
     * @param {string} ghsaId
     * @returns {Promise<import('./cache.js').CacheEntry | null>} the entry that
     *   was written, and null where the read failed.
     */
    async function read(ghsaId) {
      const advisory = { owner: ref.owner, repo: ref.repo, ghsaId };
      try {
        const response = await send(
          globalThis.bghsa.write.detailUrl(advisory),
          globalThis.bghsa.write.DETAIL_INIT
        );
        if (!(response.status >= 200 && response.status < 300)) {
          options.onFailure?.(ghsaId, `GitHub answered ${response.status}.`);
          return null;
        }
        const record = parse(await response.text(), advisory);
        if (record === null || record === undefined) {
          options.onFailure?.(ghsaId, 'The page did not read as an advisory.');
          return null;
        }
        return await globalThis.bghsa.cache.putAdvisory(advisory, record, {
          storage,
          at: clock(),
        });
      } catch (error) {
        options.onFailure?.(ghsaId, error);
        return null;
      }
    }

    /**
     * @returns {Promise<void>} waits out whatever is left of the second since
     *   the last request. The last request time is held in the progress entry,
     *   so a page that loads a moment after one went out waits out the
     *   remainder and does not spend a second request inside the same second.
     */
    async function throttle() {
      if (lastRequestAt === null) return;
      const since = Math.max(0, clock() - lastRequestAt);
      if (since >= RATE_MS) return;
      await wait(RATE_MS - since);
    }

    /** @returns {Promise<QueueSummary>} */
    async function pass() {
      while (!stopped) {
        const ghsaId = pending.shift();
        if (ghsaId === undefined) break;

        // The cache is read again here and not only when the advisory was
        // queued: opening its detail page refreshes the entry from the live DOM,
        // and that costs no request while this one would.
        const at = clock();
        const held = await globalThis.bghsa.cache.getAdvisory(
          { ...ref, ghsaId },
          { storage, at }
        );
        if (held !== null && !globalThis.bghsa.cache.isStale(held, at)) {
          if (!done.includes(ghsaId)) done.push(ghsaId);
          skipped += 1;
          report(ghsaId, held);
          await persist();
          continue;
        }

        await throttle();
        // The advisory is in flight before the request goes out, so a page that
        // goes away mid-flight leaves a record naming what was asked for.
        inFlight = ghsaId;
        lastRequestAt = clock();
        await persist();

        const entry = await read(ghsaId);
        inFlight = null;
        if (entry === null) {
          if (!failed.includes(ghsaId)) failed.push(ghsaId);
          failures += 1;
        } else {
          if (!done.includes(ghsaId)) done.push(ghsaId);
          fetched += 1;
          report(ghsaId, entry);
        }
        await persist();
      }

      const complete = pending.length === 0 && inFlight === null;
      if (complete) {
        // A finished pass leaves nothing to resume and one thing to obey: the
        // moment the last request went out. The next page load reads it and
        // waits out the rest of that second before spending a request of its
        // own.
        done = [];
        failed = [];
        startedAt = null;
        await persist();
      }
      return { fetched, skipped, failed: failures, remaining: [...pending], complete };
    }

    /**
     * Runs the queue down. Calling it while a pass is running joins that pass
     * rather than starting a second one: the queue is serial.
     *
     * @returns {Promise<QueueSummary>}
     */
    function run() {
      if (running !== null) return running;
      stopped = false;
      if (startedAt === null) startedAt = clock();
      running = (async () => {
        try {
          return await pass();
        } finally {
          running = null;
        }
      })();
      return running;
    }

    /**
     * @returns {void} stops the pass after the request in flight. What is left
     *   stays in the progress entry for the next page load.
     */
    function stop() {
      stopped = true;
    }

    return {
      ref,
      progress,
      load,
      add,
      run,
      stop,
      persist,
      /** @returns {boolean} whether a pass is running. */
      isRunning: () => running !== null,
    };
  }

  const exported = {
    RATE_MS,
    idsOf,
    progressFrom,
    plan,
    createQueue,
  };

  globalThis.bghsa.fetch = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
