'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/cache.js');
  require('../common/parse-list.js');
  require('../common/crawl.js');
  require('../common/record.js');
}

/**
 * One advisory of the done corpus: what a list page showed of it, and what an
 * advisory read holds of it.
 *
 * A member with no read is still a member. The list page named it, so its
 * identifier, its state, its severity, and the time it was opened are known
 * without a request, and a statistic over the corpus says how many of these
 * there are.
 *
 * @typedef {object} CorpusMember
 * @property {string} ghsaId
 * @property {string} state The `?state=` the crawl found it under.
 * @property {import('../common/parse-list.js').ListRow} row
 * @property {number} seenAt When the list page that named it was read.
 * @property {import('../common/parse-detail.js').ParsedDetail | null} advisory
 *   The advisory read, and null where none has landed.
 * @property {number | null} observedAt When that read was taken.
 */

/**
 * The advisories of one repository in a set of states, and what is known about
 * how much of that set this is. The done view holds the published and closed
 * pair; the statistics hold that pair and the open one.
 *
 * @typedef {object} Corpus
 * @property {CorpusMember[]} members Every advisory the crawl holds in those
 *   states, ordered by identifier so two collections of one corpus are ordered
 *   the same way.
 * @property {string[]} unread The members no advisory read backs.
 * @property {boolean} complete Whether every walk reached its last page. A
 *   corpus that is not complete holds part of the states, and how much is not
 *   known from the crawl alone.
 * @property {boolean} running Whether a collection is filling this corpus now.
 *   A corpus still being filled and one a pass gave up on are both short of the
 *   states, and only the second is a corpus that will stay that way. The
 *   `complete` flag alone does not tell them apart.
 * @property {Record<string, number | null>} expected What GitHub's own state
 *   tabs counted, by `?state=`, and null for a tab whose count went unread. It
 *   is the corpus size before any crawl, so it is what says whether the members
 *   here are all of them.
 */

/**
 * @typedef {object} CorpusOptions
 * @property {{ owner: string, repo: string }} ref
 * @property {{
 *   page: (url: string) => Promise<import('../common/fetch.js').PageRead>,
 *   add: (ghsaIds: readonly string[]) => Promise<unknown>,
 *   run: () => Promise<import('../common/fetch.js').QueueSummary>,
 *   load: () => Promise<unknown>,
 * }} queue The one queue this repository's requests go through. The corpus
 *   crawl walks list pages and reads advisories through it, so its hundred-odd
 *   reads spend the same one request a second as everything else.
 * @property {import('../common/parse-list.js').ParsedList | null} [parsed] The
 *   list page being looked at.
 * @property {string} [href] The URL of that page.
 * @property {import('../common/cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {(html: string) => import('../common/parse-list.js').ParsedList | null} [parse]
 * @property {(corpus: Corpus) => void} [onPage] Called when a page of the walk
 *   lands, which is what draws the corpus before any advisory has been read.
 * @property {(state: string, url: string, reason: unknown) => void} [onFailure]
 */

(() => {
  /**
   * The states the done corpus is the union of. REQUIREMENTS.md section 10: the
   * done view lists published and closed advisories. The four state tabs are
   * mutually exclusive, so both are walked whichever tab the page was opened
   * on, exactly as the open pair is.
   *
   * @type {readonly string[]}
   */
  const DONE_STATES = ['published', 'closed'];

  /**
   * @param {import('../common/parse-list.js').ParsedList | null | undefined} parsed
   * @param {readonly string[]} [states] The states to count, and the done pair
   *   where none is named.
   * @returns {Record<string, number | null>} what the state tabs counted, by
   *   `?state=`. A page nobody is looking at counts nothing, and a tab this
   *   reader did not find counts null: neither is a zero, because a corpus of
   *   no advisories and a corpus of unknown size are not the same thing.
   */
  function expectedOf(parsed, states = DONE_STATES) {
    /** @type {Record<string, number | null>} */
    const counts = {};
    for (const state of states) {
      const tab = parsed?.tabs?.find((entry) => entry.state === state);
      counts[state] = tab === undefined ? null : tab.count;
    }
    return counts;
  }

  /**
   * The corpus as the crawl and the cache hold it now. Nothing is fetched.
   *
   * @param {{ owner: string, repo: string }} ref
   * @param {import('../common/crawl.js').CrawledList} list What the crawl holds.
   * @param {{
   *   storage?: import('../common/cache.js').CacheStorage | null,
   *   at?: number,
   *   expected?: Record<string, number | null>,
   *   complete?: boolean,
   *   running?: boolean,
   *   states?: readonly string[],
   * }} [options] `states` names the `?state=` values the corpus is over, and is
   *   the done pair where it is absent. The statistics are over the whole
   *   corpus, so they assemble the open pair through here as well.
   * @returns {Promise<Corpus>}
   */
  async function membersOf(ref, list, options = {}) {
    const at = options.at ?? globalThis.bghsa.cache.now();
    const states = options.states ?? DONE_STATES;

    /** @type {{ ghsaId: string, state: string, row: import('../common/parse-list.js').ListRow, seenAt: number }[]} */
    const held = [];
    for (const entry of Object.values(list.rows)) {
      if (!states.includes(entry.state)) continue;
      if (entry.row.ghsaId === null) continue;
      held.push({ ghsaId: entry.row.ghsaId, state: entry.state, row: entry.row, seenAt: entry.seenAt });
    }
    held.sort((left, right) => (left.ghsaId < right.ghsaId ? -1 : left.ghsaId > right.ghsaId ? 1 : 0));

    const entries = await globalThis.bghsa.cache.getAdvisories(
      ref,
      held.map((entry) => entry.ghsaId),
      { storage: options.storage, at }
    );

    /** @type {CorpusMember[]} */
    const members = [];
    /** @type {string[]} */
    const unread = [];
    for (const entry of held) {
      const cached = entries.get(entry.ghsaId) ?? null;
      const advisory = cached === null ? null : globalThis.bghsa.record.advisoryFrom(cached.record);
      if (advisory === null) unread.push(entry.ghsaId);
      members.push({
        ghsaId: entry.ghsaId,
        state: entry.state,
        row: entry.row,
        seenAt: entry.seenAt,
        advisory,
        observedAt: advisory === null || cached === null ? null : cached.observedAt,
      });
    }

    return {
      members,
      unread,
      complete: options.complete === true,
      running: options.running === true,
      expected: options.expected ?? expectedOf(null, states),
    };
  }

  /**
   * Walks `?state=published` and `?state=closed`, then reads the advisories
   * they name.
   *
   * Both halves go through the queue the caller handed in: a list page and an
   * advisory read each cost one request, and the rate limit counts requests.
   * The corpus is a hundred-odd reads on a repository like
   * `containerd/containerd`, which is a one-time cost because a closed entry
   * lives thirty days and a published one ninety plus its draw.
   *
   * @param {CorpusOptions} options
   * @returns {Promise<{
   *   corpus: Corpus,
   *   crawled: import('../common/crawl.js').CrawlResult,
   *   read: import('../common/fetch.js').QueueSummary,
   * }>}
   */
  async function collect(options) {
    const ref = { owner: String(options.ref.owner), repo: String(options.ref.repo) };
    const clock = options.now ?? (() => globalThis.bghsa.cache.now());
    const expected = expectedOf(options.parsed);

    /**
     * @param {import('../common/crawl.js').CrawledList} list
     * @param {boolean} complete
     * @param {boolean} running Whether this collection is still going. Every
     *   corpus drawn from inside the walk is, and the one it ends on is not.
     * @returns {Promise<Corpus>}
     */
    function assemble(list, complete, running) {
      return membersOf(ref, list, {
        storage: options.storage,
        at: clock(),
        expected,
        complete,
        running,
      });
    }

    // A pass an earlier page load left unfinished is taken back before anything
    // is queued, so an advisory that pass had already read is not read again.
    await options.queue.load();

    const crawled = await globalThis.bghsa.crawl.crawl({
      ref,
      queue: options.queue,
      parsed: options.parsed,
      href: options.href,
      storage: options.storage,
      now: options.now,
      states: DONE_STATES,
      parse: options.parse,
      onFailure: options.onFailure,
      onPage: (list) => {
        if (options.onPage === undefined) return;
        // The page lands inside the walk, and what it adds to the corpus is
        // drawn without waiting for the walk to finish.
        void assemble(list, false, true).then(options.onPage, () => {});
      },
    });

    await options.queue.add(crawled.ids);
    const read = await options.queue.run();

    return { corpus: await assemble(crawled.list, crawled.complete, false), crawled, read };
  }

  const exported = { DONE_STATES, expectedOf, membersOf, collect };

  globalThis.bghsa.corpus = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
