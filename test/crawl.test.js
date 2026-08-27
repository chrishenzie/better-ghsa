'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHTML } = require('linkedom');

const cache = require('../src/common/cache.js');
const parseList = require('../src/common/parse-list.js');
const queues = require('../src/common/fetch.js');
const crawls = require('../src/common/crawl.js');

// A stand-in for `browser.storage.local`. Two crawls sharing one of these are
// two page loads sharing one browser profile.
const { fakeStorage } = require('../test-support/storage.js');

/** The repository every crawl here walks. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

const MINUTE = 60 * 1000;

/**
 * A clock a test moves by hand, and the wait a queue uses with it. Waiting moves
 * the clock and returns at once, so a walk of many pages costs no time and the
 * intervals are still exact.
 *
 * @param {number} [start]
 */
function fakeClock(start = 0) {
  let at = start;
  /** @type {number[]} */
  const waits = [];
  return {
    waits,
    now: () => at,
    /** @param {number} ms */
    advance: (ms) => {
      at += ms;
    },
    /** @param {number} ms */
    wait: async (ms) => {
      waits.push(ms);
      at += ms;
    },
  };
}

/**
 * @param {string} suffix
 * @returns {string}
 */
function ghsa(suffix) {
  return `GHSA-${suffix}-${suffix}-${suffix}`;
}

/**
 * One page of the advisory list, in the shape `parse-list` reads: the container,
 * the segmented control carrying the four tabs, the rows, and the link to the
 * next page.
 *
 * @param {{ state: string, ids: readonly string[], next?: string | null }} page
 * @returns {string}
 */
function listHtml(page) {
  const label = /** @type {string} */ (parseList.STATES[page.state]);
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  const tabs = Object.entries(parseList.STATES)
    .map(
      ([state, name]) =>
        `<li class="SegmentedControl-item${
          state === page.state ? ' SegmentedControl-item--selected' : ''
        }"><a href="${base}?state=${state}"${
          state === page.state ? ' aria-current="true"' : ''
        }>2 ${name}</a></li>`
    )
    .join('');
  const rows = page.ids
    .map(
      (id) =>
        `<div class="Box-row Box-row--drag-hide">` +
        `<a class="Link--primary" href="${base}/${id}">Title ${id}</a>` +
        `<span class="tooltipped" aria-label="${label} advisory"></span>` +
        `<span class="opened-by">opened <relative-time datetime="2026-08-01T00:00:00Z">` +
        `</relative-time> by <a class="author" href="/prakleumas">prakleumas</a></span>` +
        `</div>`
    )
    .join('');
  const next =
    page.next === undefined || page.next === null ? '' : `<a rel="next" href="${page.next}">Next</a>`;
  return (
    `<div id="advisories"><segmented-control><ul>${tabs}</ul></segmented-control>` +
    `<div class="Box">${rows}</div>${next}</div>`
  );
}

/**
 * @param {string} html
 * @returns {import('../src/common/parse-list.js').ParsedList} what that markup
 *   says.
 */
function parse(html) {
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const list = parseList.parseList(doc);
  if (list === null) throw new Error('the markup did not read as an advisory list');
  return list;
}

/**
 * A queue stand-in that answers pages from a table of them and records what was
 * asked for. It spends no slot, so a test of what a walk asks for costs no
 * clock.
 *
 * @param {Record<string, string>} pages
 */
function fakeQueue(pages) {
  /** @type {string[]} */
  const urls = [];
  return {
    urls,
    /** @param {string} url */
    page: async (url) => {
      urls.push(url);
      const body = pages[url];
      if (body === undefined) return { body: null, status: 404, reason: 'GitHub answered 404.' };
      return { body, status: 200, reason: null };
    },
  };
}

/**
 * @param {Partial<import('../src/common/crawl.js').CrawlOptions>} extra
 * @returns {import('../src/common/crawl.js').CrawlOptions}
 */
function options(extra) {
  return {
    ref: REF,
    queue: extra.queue ?? fakeQueue({}),
    parse: (html) => parse(html),
    ...extra,
  };
}

/** The first page of each open state. */
const TRIAGE_URL = `/${REF.owner}/${REF.repo}/security/advisories?state=triage`;
const DRAFT_URL = `/${REF.owner}/${REF.repo}/security/advisories?state=draft`;

test('a walk follows rel="next" through every page of a state', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({
      state: 'triage',
      ids: [ghsa('aaaa'), ghsa('bbbb')],
      next: `${TRIAGE_URL}&page=2`,
    }),
    [`${TRIAGE_URL}&page=2`]: listHtml({ state: 'triage', ids: [ghsa('cccc')] }),
  });

  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.deepStrictEqual(queue.urls, [TRIAGE_URL, `${TRIAGE_URL}&page=2`]);
  assert.deepStrictEqual(result.ids.sort(), [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')].sort());
  assert.ok(result.complete, 'the walk did not finish');
  assert.ok(result.fetched === 2, `${result.fetched} pages were read`);
});

test('both open states are crawled whichever tab the page was opened on', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
    [DRAFT_URL]: listHtml({ state: 'draft', ids: [ghsa('bbbb')] }),
  });

  // The page the maintainer is looking at is the Draft tab. The four tabs are
  // mutually exclusive, so the open set is the union of the two, and the table
  // holds both whichever one is showing.
  const result = await crawls.crawl(options({ queue, storage, now: () => 0 }));

  assert.deepStrictEqual(queue.urls.sort(), [DRAFT_URL, TRIAGE_URL].sort());
  assert.deepStrictEqual(result.ids.sort(), [ghsa('aaaa'), ghsa('bbbb')].sort());
});

test('the page being looked at costs no request', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [`${TRIAGE_URL}&page=2`]: listHtml({ state: 'triage', ids: [ghsa('cccc')] }),
    [DRAFT_URL]: listHtml({ state: 'draft', ids: [ghsa('dddd')] }),
  });
  const parsed = parse(
    listHtml({
      state: 'triage',
      ids: [ghsa('aaaa'), ghsa('bbbb')],
      next: `${TRIAGE_URL}&page=2`,
    })
  );

  const result = await crawls.crawl(
    options({
      queue,
      storage,
      now: () => 0,
      parsed,
      href: `https://github.com${TRIAGE_URL}`,
    })
  );

  // The first page of triage is the document the browser already has, so the
  // walk starts at the page after it.
  assert.deepStrictEqual(queue.urls.sort(), [`${TRIAGE_URL}&page=2`, DRAFT_URL].sort());
  assert.deepStrictEqual(
    result.ids.sort(),
    [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc'), ghsa('dddd')].sort()
  );
});

test('a page other than the first does not start the walk', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
  });
  const parsed = parse(listHtml({ state: 'triage', ids: [ghsa('bbbb')] }));

  await crawls.crawl(
    options({
      queue,
      storage,
      now: () => 0,
      states: ['triage'],
      parsed,
      href: `${TRIAGE_URL}&page=3`,
    })
  );

  // The document is the third page, so the pages before it have not been seen
  // and the walk starts where it always does.
  assert.deepStrictEqual(queue.urls, [TRIAGE_URL]);
});

test('a crawl a navigation interrupted resumes and repeats no page', async () => {
  const storage = fakeStorage();
  const pages = {
    [TRIAGE_URL]: listHtml({
      state: 'triage',
      ids: [ghsa('aaaa')],
      next: `${TRIAGE_URL}&page=2`,
    }),
    [`${TRIAGE_URL}&page=2`]: listHtml({
      state: 'triage',
      ids: [ghsa('bbbb')],
      next: `${TRIAGE_URL}&page=3`,
    }),
    [`${TRIAGE_URL}&page=3`]: listHtml({ state: 'triage', ids: [ghsa('cccc')] }),
  };

  // The first page load reads page one and then goes away: the third page is
  // absent from what this queue can answer, which is what a navigation looks
  // like to the walk.
  const first = fakeQueue({ [TRIAGE_URL]: /** @type {string} */ (pages[TRIAGE_URL]) });
  const interrupted = await crawls.crawl(
    options({ queue: first, storage, now: () => 0, states: ['triage'] })
  );
  assert.deepStrictEqual(first.urls, [TRIAGE_URL, `${TRIAGE_URL}&page=2`]);
  assert.ok(!interrupted.complete, 'an interrupted walk reported itself finished');

  const second = fakeQueue(pages);
  const resumed = await crawls.crawl(
    options({ queue: second, storage, now: () => MINUTE, states: ['triage'] })
  );

  // It asks for the page it had reached, and for no page before it.
  assert.deepStrictEqual(second.urls, [`${TRIAGE_URL}&page=2`, `${TRIAGE_URL}&page=3`]);
  // The advisory the first pass saw is still held, so nothing was lost either.
  assert.deepStrictEqual(resumed.ids.sort(), [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')].sort());
  assert.ok(resumed.complete, 'the resumed walk did not finish');
});

test('a crawl that finished four minutes ago walks nothing', async () => {
  const storage = fakeStorage();
  const pages = {
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
    [DRAFT_URL]: listHtml({ state: 'draft', ids: [ghsa('bbbb')] }),
  };
  const first = fakeQueue(pages);
  await crawls.crawl(options({ queue: first, storage, now: () => 0 }));
  assert.ok(first.urls.length === 2, `${first.urls.length} pages were read`);

  const soon = fakeQueue(pages);
  const held = await crawls.crawl(options({ queue: soon, storage, now: () => 4 * MINUTE }));
  assert.deepStrictEqual(soon.urls, [], 'a crawl inside the staleness threshold spent requests');
  assert.deepStrictEqual(held.ids.sort(), [ghsa('aaaa'), ghsa('bbbb')].sort());

  const later = fakeQueue(pages);
  await crawls.crawl(options({ queue: later, storage, now: () => 6 * MINUTE }));
  assert.ok(later.urls.length === 2, `${later.urls.length} pages were read after the threshold`);
});

test('an advisory that left a state is dropped when that state is walked again', async () => {
  const storage = fakeStorage();
  const first = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa'), ghsa('bbbb')] }),
  });
  const before = await crawls.crawl(
    options({ queue: first, storage, now: () => 0, states: ['triage'] })
  );
  assert.deepStrictEqual(before.ids.sort(), [ghsa('aaaa'), ghsa('bbbb')].sort());

  // The second advisory was published, so the next walk of triage does not see
  // it. It leaves the table with the state it left.
  const second = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
  });
  const after = await crawls.crawl(
    options({ queue: second, storage, now: () => 6 * MINUTE, states: ['triage'] })
  );
  assert.deepStrictEqual(after.ids, [ghsa('aaaa')]);
});

test('a walk stopped part way keeps the advisories it has not seen again', async () => {
  const storage = fakeStorage();
  const pages = {
    [TRIAGE_URL]: listHtml({
      state: 'triage',
      ids: [ghsa('aaaa')],
      next: `${TRIAGE_URL}&page=2`,
    }),
  };
  await crawls.crawl(
    options({ queue: fakeQueue(pages), storage, now: () => 0, states: ['triage'] })
  );

  // The walk stopped before its last page, so what it did not reach this time
  // is not gone: a second pass that stops the same way still holds the first
  // page's advisory.
  const again = await crawls.crawl(
    options({ queue: fakeQueue(pages), storage, now: () => MINUTE, states: ['triage'] })
  );
  assert.deepStrictEqual(again.ids, [ghsa('aaaa')]);
});

test('a next link that leaves this repository is not followed', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({
      state: 'triage',
      ids: [ghsa('aaaa')],
      next: 'https://example.invalid/anything',
    }),
  });
  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.deepStrictEqual(queue.urls, [TRIAGE_URL]);
  assert.ok(result.complete, 'the walk did not treat an unusable next link as the last page');

  assert.ok(crawls.advisoriesPath('/other/repo/security/advisories?state=triage', REF) === null);
  assert.ok(crawls.advisoriesPath('//evil.example/x', REF) === null);
  assert.ok(
    crawls.advisoriesPath(`https://github.com${TRIAGE_URL}`, REF) === TRIAGE_URL,
    'a next link GitHub wrote in full was refused'
  );
});

test('a walk gives up rather than following a cycle', async () => {
  const storage = fakeStorage();
  // Every page names itself as the next one, which is what a walk with no bound
  // would follow forever at a request a second.
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')], next: TRIAGE_URL }),
  });
  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'], maxPages: 3 })
  );

  assert.ok(queue.urls.length === 3, `${queue.urls.length} pages were read`);
  assert.deepStrictEqual(result.ids, [ghsa('aaaa')]);
});

test('a crawl record of another shape crawls from the start', async () => {
  const storage = fakeStorage();
  await cache.putList(REF, { walks: 'everything', rows: 7 }, { storage, at: 0 });
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
  });
  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.deepStrictEqual(queue.urls, [TRIAGE_URL]);
  assert.deepStrictEqual(result.ids, [ghsa('aaaa')]);
  assert.deepStrictEqual(crawls.listFrom(null), { walks: {}, rows: {} });
  assert.deepStrictEqual(crawls.listFrom(12), { walks: {}, rows: {} });
});

