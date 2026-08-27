'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./schema.js');
  require('./cache.js');
  require('./parse-list.js');
}

/**
 * One advisory as a list page showed it, and where the crawl found it.
 *
 * @typedef {object} CrawledRow
 * @property {import('./parse-list.js').ListRow} row
 * @property {string} state The `?state=` this advisory was found under.
 * @property {number} seenAt When it was last seen there, epoch milliseconds.
 */

/**
 * How far the walk of one state has got. It is held in the cache, so a walk a
 * navigation interrupted carries on from the page it had reached rather than
 * from the first one.
 *
 * @typedef {object} StateWalk
 * @property {string | null} next The page still to read, and null where there
 *   is none left.
 * @property {boolean} started
 * @property {boolean} complete Whether the walk reached the last page.
 * @property {number} startedAt When this walk began, epoch milliseconds.
 * @property {number} completedAt When it reached the last page, and 0 while it
 *   has not.
 * @property {number} pages How many pages it has read.
 */

/**
 * Every open advisory this extension has seen on one repository, and how far the
 * walk of each state has got. It is the record the list cache entry holds.
 *
 * @typedef {object} CrawledList
 * @property {Record<string, StateWalk>} walks By `?state=` value.
 * @property {Record<string, CrawledRow>} rows By GHSA identifier.
 */

/**
 * @typedef {object} CrawlResult
 * @property {CrawledList} list What the crawl holds now.
 * @property {string[]} ids The advisories in the states this crawl covers.
 * @property {number} fetched Pages read over the network.
 * @property {number} failed Pages this pass could not read.
 * @property {boolean} complete Whether every state's walk has reached its last
 *   page.
 */

/**
 * @typedef {object} CrawlOptions
 * @property {{ owner: string, repo: string }} ref The repository being crawled.
 * @property {{ page: (url: string) => Promise<import('./fetch.js').PageRead> }} queue
 *   The one queue this repository's requests go through. A page of the list
 *   costs a request exactly as an advisory read does, so both spend its slot.
 * @property {import('./parse-list.js').ParsedList | null} [parsed] The list page
 *   the maintainer is looking at. Its rows cost no request, and where it is the
 *   first page of its state the walk of that state starts from it.
 * @property {string} [href] The URL of that page, which is what says whether it
 *   is the first page of its state.
 * @property {import('./cache.js').CacheStorage | null} [storage]
 * @property {() => number} [now]
 * @property {readonly string[]} [states] The states to walk, and absent for the
 *   open pair.
 * @property {number} [maxPages] How many pages one state's walk may read.
 * @property {(html: string) => import('./parse-list.js').ParsedList | null} [parse]
 * @property {(list: CrawledList) => void} [onPage] Called when a page lands and
 *   when the live page's own rows are taken in, which is what repaints the
 *   table.
 * @property {(state: string, url: string, reason: unknown) => void} [onFailure]
 */

(() => {
  /**
   * How many pages one state's walk may read.
   *
   * GitHub pages the advisory list, and the walk follows what the page says the
   * next one is. A `rel="next"` that names a page already read would otherwise
   * walk forever at a request a second. Fifty pages is far past any repository's
   * open set: `containerd/containerd` has shown tens of open advisories, and a
   * page holds twenty-five.
   */
  const MAX_PAGES = 50;

  /**
   * @param {unknown} value
   * @returns {string | null} the string it holds, and null for anything else.
   */
  function textOf(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /**
   * @param {unknown} value
   * @returns {number} the number it holds, and 0 for anything else.
   */
  function timeOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  /**
   * @param {unknown} value
   * @returns {string | null} the `?state=` value this names, and null for a name
   *   that is not one of GitHub's four.
   */
  function stateKeyOf(value) {
    const wanted = String(value ?? '').trim().toLowerCase();
    return Object.hasOwn(globalThis.bghsa.parseList.STATES, wanted) ? wanted : null;
  }

  /**
   * @param {{ owner: string, repo: string }} ref
   * @param {string} state
   * @returns {string} the first page of one state's advisory list.
   */
  function listUrl(ref, state) {
    const owner = encodeURIComponent(ref.owner);
    const repo = encodeURIComponent(ref.repo);
    return `/${owner}/${repo}/security/advisories?state=${encodeURIComponent(state)}`;
  }

  /**
   * The page a `rel="next"` link names, as a path this crawl will ask GitHub
   * for.
   *
   * A walk follows links out of a page GitHub rendered, so it checks where each
   * one goes: the only thing it asks for is another page of this repository's
   * own advisory list.
   *
   * @param {unknown} href
   * @param {{ owner: string, repo: string }} ref
   * @returns {string | null}
   */
  function advisoriesPath(href, ref) {
    let path = String(href ?? '').trim();
    if (path === '') return null;
    const origin = 'https://github.com';
    if (path.toLowerCase().startsWith(origin)) path = path.slice(origin.length);
    if (!path.startsWith('/')) return null;
    const withoutFragment = /** @type {string} */ (path.split('#')[0] ?? '');
    const base = /** @type {string} */ (withoutFragment.split('?')[0] ?? '');
    const wanted = `/${ref.owner}/${ref.repo}/security/advisories`;
    return base.toLowerCase() === wanted.toLowerCase() ? withoutFragment : null;
  }

  /**
   * @param {string | undefined} href The URL of the page being looked at.
   * @returns {number | null} the page of the list it is, and null where the URL
   *   does not say. A list URL carrying no `?page=` is the first page.
   */
  function pageOf(href) {
    if (href === undefined) return null;
    const query = /** @type {string} */ (href.split('#')[0]?.split('?')[1] ?? '');
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      if ((eq === -1 ? pair : pair.slice(0, eq)) !== 'page') continue;
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      return /^\d+$/.test(value) ? Number(value) : null;
    }
    return 1;
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-list.js').ListRow | null} the row it holds, and
   *   null where it holds something else. The record is data an older version of
   *   this extension wrote, so its shape is checked and never assumed.
   */
  function rowFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const ghsaId = textOf(value.ghsaId);
    if (ghsaId === null) return null;
    return {
      ghsaId,
      owner: textOf(value.owner),
      repo: textOf(value.repo),
      href: textOf(value.href),
      title: textOf(value.title),
      state: textOf(value.state),
      severity: textOf(value.severity),
      severityLabel: textOf(value.severityLabel),
      openedAt: textOf(value.openedAt),
      reporter: textOf(value.reporter),
    };
  }

  /**
   * @param {unknown} value
   * @returns {StateWalk | null}
   */
  function walkFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    return {
      next: textOf(value.next),
      started: value.started === true,
      complete: value.complete === true,
      startedAt: timeOf(value.startedAt),
      completedAt: timeOf(value.completedAt),
      pages: Math.max(0, Math.trunc(timeOf(value.pages))),
    };
  }

  /**
   * @param {unknown} value The list entry's record as the cache handed it back.
   * @returns {CrawledList} what it holds, and an empty crawl where it holds
   *   something else.
   */
  function listFrom(value) {
    /** @type {CrawledList} */
    const list = { walks: {}, rows: {} };
    if (!globalThis.bghsa.schema.isPlainObject(value)) return list;
    if (globalThis.bghsa.schema.isPlainObject(value.walks)) {
      for (const [state, held] of Object.entries(value.walks)) {
        const key = stateKeyOf(state);
        const walk = walkFrom(held);
        if (key !== null && walk !== null) list.walks[key] = walk;
      }
    }
    if (globalThis.bghsa.schema.isPlainObject(value.rows)) {
      for (const held of Object.values(value.rows)) {
        if (!globalThis.bghsa.schema.isPlainObject(held)) continue;
        const row = rowFrom(held.row);
        const state = stateKeyOf(held.state);
        if (row === null || state === null || row.ghsaId === null) continue;
        list.rows[row.ghsaId] = { row, state, seenAt: timeOf(held.seenAt) };
      }
    }
    return list;
  }

  /**
   * @param {CrawledList} list
   * @param {string} state
   * @returns {StateWalk} the walk held for that state, and one that has not
   *   started where none is held.
   */
  function walkOf(list, state) {
    return (
      list.walks[state] ?? {
        next: null,
        started: false,
        complete: false,
        startedAt: 0,
        completedAt: 0,
        pages: 0,
      }
    );
  }

  /**
   * Takes one page's rows into the crawl. The state is the one the page was
   * asked for under, which is what the row belongs to whatever its own chip
   * reads.
   *
   * @param {CrawledList} list
   * @param {readonly import('./parse-list.js').ListRow[]} rows
   * @param {string} state
   * @param {number} at
   * @returns {void}
   */
  function absorb(list, rows, state, at) {
    for (const row of rows) {
      if (row.ghsaId === null) continue;
      list.rows[row.ghsaId] = { row, state, seenAt: at };
    }
  }

  /**
   * Drops the advisories that were in one state when it was last walked and are
   * not in it now: an advisory a maintainer published, closed, or moved to the
   * other open state.
   *
   * Only a walk that reached its last page prunes. A walk that stopped part way
   * has seen part of the state, and the rest is not gone.
   *
   * @param {CrawledList} list
   * @param {string} state
   * @param {number} startedAt When the walk that just finished began.
   * @returns {void}
   */
  function prune(list, state, startedAt) {
    for (const [ghsaId, held] of Object.entries(list.rows)) {
      if (held.state === state && held.seenAt < startedAt) delete list.rows[ghsaId];
    }
  }

  /**
   * @param {CrawledList} list
   * @param {readonly string[]} states
   * @returns {import('./parse-list.js').ListRow[]} the advisories the crawl
   *   holds in those states, which for the open pair is every advisory the list
   *   table shows.
   */
  function rowsIn(list, states) {
    /** @type {import('./parse-list.js').ListRow[]} */
    const rows = [];
    for (const held of Object.values(list.rows)) {
      if (states.includes(held.state)) rows.push(held.row);
    }
    return rows;
  }

  /**
   * @param {CrawledList} list
   * @param {readonly string[]} states
   * @returns {string[]} the identifiers of those advisories.
   */
  function idsIn(list, states) {
    /** @type {string[]} */
    const ids = [];
    for (const row of rowsIn(list, states)) {
      if (row.ghsaId !== null && !ids.includes(row.ghsaId)) ids.push(row.ghsaId);
    }
    return ids;
  }

  /**
   * @param {CrawledList} list
   * @param {string} state
   * @param {number} at
   * @returns {boolean} whether that state is worth walking now: it has never
   *   been walked, a walk of it stopped part way, or the last walk finished
   *   longer ago than the staleness threshold.
   */
  function isDue(list, state, at) {
    const walk = walkOf(list, state);
    if (!walk.started) return true;
    if (!walk.complete) return true;
    return at - walk.completedAt >= globalThis.bghsa.cache.STALE_MS;
  }

  /**
   * Takes in the page the maintainer is looking at. Its rows are advisories seen
   * now at no request cost, and where it is the first page of its state the walk
   * of that state starts from it rather than asking GitHub for a page it already
   * has.
   *
   * @param {CrawledList} list
   * @param {import('./parse-list.js').ParsedList} parsed
   * @param {{ ref: { owner: string, repo: string }, at: number, page: number | null, states: readonly string[] }} where
   * @returns {void}
   */
  function seed(list, parsed, where) {
    const selected = parsed.selectedState === null ? null : stateKeyOf(parsed.selectedState);
    const at = where.at;

    if (
      selected !== null &&
      where.states.includes(selected) &&
      where.page === 1 &&
      isDue(list, selected, at)
    ) {
      const next = advisoriesPath(parsed.next?.href, where.ref);
      list.walks[selected] = {
        next,
        started: true,
        complete: next === null,
        startedAt: at,
        completedAt: next === null ? at : 0,
        pages: 1,
      };
    }

    for (const row of parsed.rows) {
      if (row.ghsaId === null) continue;
      const state = stateKeyOf(row.state) ?? selected;
      if (state === null || !where.states.includes(state)) continue;
      list.rows[row.ghsaId] = { row, state, seenAt: at };
    }

    if (selected === null) return;
    const walk = list.walks[selected];
    if (walk !== undefined && walk.complete && walk.completedAt === at) {
      prune(list, selected, walk.startedAt);
    }
  }

  /**
   * Walks every open state of one repository's advisory list, page by page.
   *
   * The four state tabs are mutually exclusive, so the open set is the union of
   * `?state=triage` and `?state=draft`, and both are walked whichever tab the
   * page was opened on.
   *
   * What is persisted after every page is the page each state's walk has still
   * to read and every advisory seen so far. A reload therefore asks for the page
   * the walk had reached and no earlier one, and the advisories already seen
   * paint from the same record with nothing fetched.
   *
   * @param {CrawlOptions} options
   * @returns {Promise<CrawlResult>}
   */
  async function crawl(options) {
    const ref = { owner: String(options.ref.owner), repo: String(options.ref.repo) };
    const storage = options.storage ?? null;
    const clock = options.now ?? (() => globalThis.bghsa.cache.now());
    const states = options.states ?? globalThis.bghsa.parseList.OPEN_STATES;
    const maxPages = options.maxPages ?? MAX_PAGES;
    const parse =
      options.parse ??
      ((html) =>
        globalThis.bghsa.parseList.parseList(new DOMParser().parseFromString(html, 'text/html')));

    /**
     * @returns {Promise<void>} holds the crawl where the next page load reads
     *   it.
     */
    async function persist() {
      await globalThis.bghsa.cache.putList(ref, list, { storage, at: clock() });
    }

    /** @returns {void} tells the caller there is more of the list to draw. */
    function report() {
      if (options.onPage === undefined) return;
      try {
        options.onPage(list);
      } catch {
        // The listener that would hear about it is the one that threw. The
        // crawl is what fills the table, and it carries on.
      }
    }

    /**
     * @param {string} state
     * @param {string} url
     * @param {unknown} reason
     * @returns {void}
     */
    function fail(state, url, reason) {
      if (options.onFailure === undefined) return;
      try {
        options.onFailure(state, url, reason);
      } catch {
        // As above.
      }
    }

    const held = await globalThis.bghsa.cache.getList(ref, { storage, at: clock() });
    const list = listFrom(held === null ? null : held.record);

    if (options.parsed !== undefined && options.parsed !== null) {
      seed(list, options.parsed, {
        ref,
        at: clock(),
        page: pageOf(options.href),
        states,
      });
      await persist();
      report();
    }

    let fetched = 0;
    let failed = 0;

    for (const state of states) {
      if (!isDue(list, state, clock())) continue;
      if (!walkOf(list, state).started || walkOf(list, state).complete) {
        list.walks[state] = {
          next: listUrl(ref, state),
          started: true,
          complete: false,
          startedAt: clock(),
          completedAt: 0,
          pages: 0,
        };
        await persist();
      }

      for (;;) {
        const walk = walkOf(list, state);
        const url = walk.next;
        if (walk.complete || url === null) break;

        const answer = await options.queue.page(url);
        if (answer.body === null) {
          // The page the walk had reached stays in the record, so the next page
          // load asks for that one and for no page before it.
          failed += 1;
          fail(state, url, answer.reason);
          break;
        }
        fetched += 1;

        const page = parse(answer.body);
        if (page === null) {
          failed += 1;
          fail(state, url, 'The page did not read as an advisory list.');
          break;
        }

        const at = clock();
        absorb(list, page.rows, state, at);
        const next = advisoriesPath(page.next?.href, ref);
        const pages = walk.pages + 1;
        const complete = next === null || pages >= maxPages;
        list.walks[state] = {
          next,
          started: true,
          complete,
          startedAt: walk.startedAt,
          completedAt: complete ? at : 0,
          pages,
        };
        // A walk that gave up at the page bound has not seen the whole state, so
        // what it did not see this time is not gone.
        if (next === null) prune(list, state, walk.startedAt);
        await persist();
        report();
        if (complete) break;
      }
    }

    return {
      list,
      ids: idsIn(list, states),
      fetched,
      failed,
      complete: states.every((state) => walkOf(list, state).complete),
    };
  }

  const exported = {
    MAX_PAGES,
    stateKeyOf,
    listUrl,
    advisoriesPath,
    pageOf,
    rowFrom,
    listFrom,
    walkOf,
    absorb,
    prune,
    rowsIn,
    idsIn,
    isDue,
    seed,
    crawl,
  };

  globalThis.bghsa.crawl = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
