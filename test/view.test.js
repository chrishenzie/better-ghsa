'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML, DOMParser } = require('linkedom');

const cache = require('../src/common/cache.js');
const parseList = require('../src/common/parse-list.js');
const parseDetail = require('../src/common/parse-detail.js');
const schema = require('../src/common/schema.js');
const write = require('../src/common/write.js');
const edit = require('../src/detail/edit.js');
const table = require('../src/list/table.js');
const csv = require('../src/done/csv.js');
const corpus = require('../src/done/corpus.js');
const view = require('../src/done/view.js');

const { fakeStorage } = require('../test-support/storage.js');

// The queue and the crawl turn a fetched page into a document the way a content
// script does. Nothing in this file reaches the network: every response is a
// string a test wrote.
globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

/** The repository the list fixture belongs to, and the one on the allowlist. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

/** The advisory the triage fixture holds. */
const TRIAGE_ID = 'GHSA-jmvx-2wfw-xfgj';

test('the storage stand-in holds a copy of what it was seeded with', async () => {
  // `browser.storage.local` stores a structured clone. A fake holding the
  // caller's own object would let the code under test read back a change it
  // never wrote, and would carry a write out of the test that made it.
  const held = { advisory: { read: 1 } };
  const store = fakeStorage(held);
  await store.set({ advisory: { read: 2 } });
  assert.deepStrictEqual(held, { advisory: { read: 1 } }, 'a write reached the seed');
  assert.deepStrictEqual((await store.get('advisory'))['advisory'], { read: 2 });
});

const MINUTE = 60 * 1000;

/** A clock the queue moves rather than waiting on, so a crawl costs no time. */
let clockAt = Date.parse('2026-08-27T12:00:00Z');
cache.setClock(() => clockAt);
cache.setStorage(fakeStorage());

/** What the queue answers with, by path. A test fills this in before it runs. */
/** @type {Record<string, string>} */
const pages = {};

/** Every path the queue asked for, in order. @type {string[]} */
const asked = [];

/**
 * The one queue this repository's requests go through, made here so the view's
 * own collection finds it rather than making one that would reach the network.
 */
table.queueFor(REF, {
  storage: cache.storageOf(),
  now: () => clockAt,
  wait: async (ms) => {
    clockAt += ms;
  },
  fetch: async (url) => {
    asked.push(url);
    const body = pages[url];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  },
});

/**
 * @param {string} name
 * @returns {string} one fixture's markup.
 */
function fixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
}

/**
 * @param {string} html
 * @returns {Document}
 */
function document(html) {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * The list fixture inside the frame GitHub replaces on a soft navigation.
 *
 * @param {string} name
 * @returns {Document}
 */
function listPage(name) {
  return document(
    '<!doctype html><html><head></head><body><div id="repo-content-turbo-frame">' +
      fixture(name) +
      '</div></body></html>'
  );
}

/**
 * @param {ParentNode} scope
 * @param {string} selector
 * @returns {Element}
 */
function one(scope, selector) {
  const found = scope.querySelector(selector);
  if (found === null) throw new Error(`nothing matched ${selector}`);
  return found;
}

/**
 * @param {ParentNode} scope
 * @param {string} selector
 * @returns {string}
 */
function textOf(scope, selector) {
  return (one(scope, selector).textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {ParentNode} scope
 * @param {string} selector
 * @returns {string[]} what every match reads, whitespace collapsed.
 */
function textsOf(scope, selector) {
  return Array.from(scope.querySelectorAll(selector)).map((node) =>
    (node.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

/**
 * Picks an option the way a maintainer does. The selection is the `selected`
 * attribute here, which is what this document model reads a select's value
 * from.
 *
 * @param {Element} select
 * @param {string} value
 * @returns {void}
 */
function choose(select, value) {
  for (const option of select.querySelectorAll('option')) {
    if ((option.getAttribute('value') ?? '') === value) option.setAttribute('selected', '');
    else option.removeAttribute('selected');
  }
  const view = select.ownerDocument?.defaultView;
  if (view === null || view === undefined) throw new Error('the document has no view');
  select.dispatchEvent(new view.Event('change', { bubbles: true }));
}

/**
 * @param {Element} row
 * @returns {string} every chip under one row's title, as one line. The chips
 *   sit against each other, so the text alone runs them together.
 */
function chipLine(row) {
  return textsOf(row, '.bghsa-done-chips span.Label').join(' ');
}

/**
 * @param {Document} doc
 * @param {string} ghsaId
 * @returns {Element} that advisory's row on the done view. The table carries a
 *   row under the same attribute, so the view is named in the query.
 */
function doneRow(doc, ghsaId) {
  return one(doc, `#${view.ROOT_ID} [data-bghsa-ghsa="${ghsaId}"]`);
}

/**
 * @param {Document} doc
 * @returns {HTMLElement} the toggle this view puts on the bar.
 */
function doneToggle(doc) {
  return /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-done-toggle`))
  );
}

/**
 * @param {Document} doc
 * @returns {HTMLElement} the toggle that restores GitHub's view.
 */
function githubToggle(doc) {
  return /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-list-toggle`))
  );
}

/**
 * @param {string} suffix
 * @returns {string}
 */
function ghsa(suffix) {
  return `GHSA-${suffix}-${suffix}-${suffix}`;
}

/**
 * One page of the advisory list, in the shape `parse-list` reads.
 *
 * @param {{ state: string, ids: readonly string[], counts?: Record<string, number> }} page
 * @returns {string}
 */
function listHtml(page) {
  const label = /** @type {string} */ (parseList.STATES[page.state]);
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  const counts = page.counts ?? {};
  const tabs = Object.entries(parseList.STATES)
    .map(
      ([state, name]) =>
        `<li class="SegmentedControl-item"><a href="${base}?state=${state}"${
          state === page.state ? ' aria-current="true"' : ''
        }>${counts[state] ?? 0} ${name}</a></li>`
    )
    .join('');
  const rows = page.ids
    .map(
      (id) =>
        '<div class="Box-row Box-row--drag-hide">' +
        `<a class="Link--primary" href="${base}/${id}">Title ${id}</a>` +
        `<span class="tooltipped" aria-label="${label} advisory"></span>` +
        '<span class="Label" title="Severity: High">High</span>' +
        '<span class="opened-by">opened <relative-time datetime="2026-03-02T00:00:00Z">' +
        '</relative-time> by <a class="author" href="/prakleumas">prakleumas</a></span>' +
        '</div>'
    )
    .join('');
  return (
    `<div id="advisories"><segmented-control><ul>${tabs}</ul></segmented-control>` +
    `<div class="Box">${rows}</div></div>`
  );
}

/**
 * One advisory detail page, in the shape `parse-detail` reads.
 *
 * @param {{ ghsaId: string, state: string, reportedAt: string }} advisory
 * @returns {string}
 */
function detailHtml(advisory) {
  return (
    `<div class="gh-header-meta"><span class="State">${advisory.state}</span>` +
    '<span class="Label--large" title="Severity: High">High</span>' +
    `<span class="user-select-contain">${advisory.ghsaId}</span></div>` +
    '<div class="js-repository-advisory-details"><div class="Box-header timeline-comment-header">' +
    '<a class="author" href="/prakleumas">prakleumas</a> opened ' +
    `<relative-time datetime="${advisory.reportedAt}"></relative-time></div></div>`
  );
}

/**
 * @param {string} ghsaId
 * @returns {string}
 */
function detailUrl(ghsaId) {
  return `/${REF.owner}/${REF.repo}/security/advisories/${ghsaId}`;
}

/** An advisory in the shape the parser produces, carrying only what is read. */
/**
 * @param {Partial<import('../src/common/parse-detail.js').ParsedDetail>} fields
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function advisory(fields) {
  return {
    ref: null,
    viewer: null,
    ghsaId: null,
    state: null,
    severity: null,
    severityLabel: null,
    reportedAt: null,
    reporter: null,
    title: null,
    description: null,
    severityField: null,
    severityFieldPresent: false,
    cvssV3: null,
    cvssV3Present: false,
    cveId: null,
    cveSelection: null,
    descriptionOriginal: null,
    descriptionRevision: null,
    comments: [],
    timeline: [],
    fork: null,
    collaborators: [],
    ...fields,
  };
}

/**
 * @param {{
 *   ghsaId: string,
 *   state: string,
 *   title?: string | null,
 *   severity?: string | null,
 *   openedAt?: string | null,
 *   advisory?: import('../src/common/parse-detail.js').ParsedDetail | null,
 * }} fields
 * @returns {import('../src/done/corpus.js').CorpusMember}
 */
function member(fields) {
  const read = fields.advisory ?? null;
  return {
    ghsaId: fields.ghsaId,
    state: fields.state,
    seenAt: 0,
    advisory: read,
    observedAt: read === null ? null : Date.parse('2026-08-27T09:00:00Z'),
    row: {
      ghsaId: fields.ghsaId,
      owner: REF.owner,
      repo: REF.repo,
      href: `/${REF.owner}/${REF.repo}/security/advisories/${fields.ghsaId}`,
      title: fields.title ?? null,
      state: fields.state,
      severity: fields.severity ?? null,
      severityLabel: null,
      openedAt: fields.openedAt ?? null,
      reporter: 'prakleumas',
    },
  };
}

/**
 * @param {readonly import('../src/done/corpus.js').CorpusMember[]} members
 * @param {{ complete?: boolean, expected?: Record<string, number | null> }} [over]
 * @returns {import('../src/done/corpus.js').Corpus}
 */
function corpusOf(members, over = {}) {
  return {
    members: [...members],
    unread: members.filter((each) => each.advisory === null).map((each) => each.ghsaId),
    complete: over.complete ?? true,
    expected: over.expected ?? { published: null, closed: null },
  };
}

/**
 * The corpus as production builds it: `membersOf` over the crawl's rows and
 * the cache's entries. Nothing here hands a member an advisory object. A
 * member's advisory is what `record.advisoryFrom` reads back out of storage,
 * which is the only advisory the done view ever holds, so a control this
 * exercises is the control a maintainer gets.
 *
 * @param {readonly { ghsaId: string, state: string, record?: unknown }[]} entries
 * @returns {Promise<import('../src/done/corpus.js').Corpus>}
 */
async function cachedCorpus(entries) {
  /** @type {Record<string, unknown>} */
  const stored = {};
  /** @type {import('../src/common/crawl.js').CrawledList} */
  const list = { walks: {}, rows: {} };
  for (const entry of entries) {
    list.rows[entry.ghsaId] = {
      row: member({ ghsaId: entry.ghsaId, state: entry.state }).row,
      state: entry.state,
      seenAt: clockAt,
    };
    if (entry.record === undefined) continue;
    const key = /** @type {string} */ (cache.advisoryKey({ ...REF, ghsaId: entry.ghsaId }));
    stored[key] = { record: entry.record, observedAt: clockAt, state: entry.state };
  }
  return corpus.membersOf(REF, list, {
    storage: fakeStorage(stored),
    at: clockAt,
    complete: true,
    expected: { published: null, closed: null },
  });
}

/**
 * A rendered list page carrying the extension's table and this view.
 *
 * @param {import('../src/done/corpus.js').Corpus | null} [corpus]
 * @returns {Promise<Document>}
 */
async function page(corpus = null) {
  const doc = listPage('list-page-triage.html');
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');
  if (corpus !== null) {
    view.setState(doc, { corpus, ref: REF });
    view.draw(doc);
  }
  return doc;
}

test('the done view is reached from a toggle beside the one for GitHub', async () => {
  const published = [ghsa('aaaa'), ghsa('bbbb')];
  const closed = [ghsa('cccc')];
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids: published,
    counts: { published: 2, closed: 1 },
  });
  pages[`${base}?state=closed`] = listHtml({
    state: 'closed',
    ids: closed,
    counts: { published: 2, closed: 1 },
  });
  for (const id of published) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  for (const id of closed) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Closed',
      reportedAt: '2026-04-05T00:00:00Z',
    });
  }

  const doc = await page();
  const toggle = doneToggle(doc);
  assert.strictEqual(
    (toggle.textContent ?? '').trim(),
    view.SHOW_DONE,
    'the toggle offers the view'
  );
  assert.ok(
    toggle.previousElementSibling === githubToggle(doc),
    "the toggle sits beside the one that restores GitHub's view"
  );

  const before = asked.length;
  toggle.click();
  await view.collect(doc);

  assert.strictEqual(table.viewMode(doc), view.MODE, 'the page is on the done view');
  assert.strictEqual(
    (doneToggle(doc).textContent ?? '').trim(),
    view.SHOW_OPEN,
    'and the toggle offers the way back'
  );

  // The list pages and every advisory they name, all through the one queue the
  // list surface holds for this repository.
  assert.deepStrictEqual(asked.slice(before), [
    `${base}?state=published`,
    `${base}?state=closed`,
    detailUrl(published[0] ?? ''),
    detailUrl(published[1] ?? ''),
    detailUrl(closed[0] ?? ''),
  ]);

  const rows = doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`);
  assert.strictEqual(rows.length, 3, `rows on the done view: ${rows.length}`);
  assert.deepStrictEqual(
    Array.from(rows).map((row) => row.getAttribute('data-bghsa-ghsa')),
    [...published, ...closed].sort()
  );
  assert.deepStrictEqual(
    Array.from(rows).map(chipLine),
    ['Published High', 'Published High', 'Closed High'],
    'each row says which done state it is in'
  );
  assert.strictEqual(
    textOf(doc, `#${view.ROOT_ID} .bghsa-done-count`),
    '3 advisories',
    'the header counts what the view holds'
  );

  // Nothing the view inserts reads back as one of GitHub's own rows.
  const inserted = one(doc, `#${view.ROOT_ID}`).querySelectorAll(
    table.PARSED_SELECTORS.join(', ')
  ).length;
  assert.strictEqual(inserted, 0, `nodes parse-list would key on: ${inserted}`);
  const reread = parseList.parseList(doc);
  assert.strictEqual(reread?.rows.length, 1, "a re-read still finds GitHub's one row");
});

test("the three views converge, and GitHub's own view comes back whole", async () => {
  const doc = await page(
    corpusOf([member({ ghsaId: ghsa('dddd'), state: 'published', title: 'A published advisory' })])
  );
  const container = one(doc, '#advisories');
  const native = table.nativeControls(container);
  const listBox = one(doc, `#${table.ROOT_ID} .bghsa-list-box`);

  /**
   * @returns {string} which of the three is in view, named once. Two of them
   *   showing at once, or none, is what this catches.
   */
  const showing = () => {
    const shown = [];
    if (native.some((node) => !node.classList.contains(table.HIDDEN_CLASS))) shown.push('native');
    if (!listBox.classList.contains(table.HIDDEN_CLASS)) shown.push('table');
    if (!one(doc, `#${view.ROOT_ID}`).classList.contains(table.HIDDEN_CLASS)) shown.push('done');
    return shown.join('+');
  };

  assert.strictEqual(showing(), 'table', 'a fresh page comes up on the table');

  doneToggle(doc).click();
  assert.strictEqual(showing(), 'done');
  githubToggle(doc).click();
  assert.strictEqual(showing(), 'native', "the done view gives way to GitHub's");
  doneToggle(doc).click();
  assert.strictEqual(showing(), 'done', "and GitHub's gives way to the done view");
  doneToggle(doc).click();
  assert.strictEqual(showing(), 'table', 'pressing it again gives the table back');
  githubToggle(doc).click();
  assert.strictEqual(showing(), 'native');
  githubToggle(doc).click();
  assert.strictEqual(showing(), 'table');

  // Hiding is not destroying: what came back is GitHub's own view, whole.
  githubToggle(doc).click();
  assert.strictEqual(
    doc.querySelectorAll('#advisories div.Box-row--drag-hide').length,
    1,
    "GitHub's own rows"
  );
  assert.strictEqual(
    doc.querySelectorAll('#advisories segmented-control a[href]').length,
    4,
    'the state tabs'
  );
  assert.strictEqual(
    doc.querySelectorAll('#advisories repository-advisories-filter form').length,
    1,
    'the query form'
  );
  assert.ok(
    doc.getElementById(view.ROOT_ID) !== null,
    'the done view is held out of view, not taken away'
  );
});

test('a statistic over a partly-read corpus says what it is over', async () => {
  const read = advisory({
    ref: { ...REF, ghsaId: ghsa('eeee') },
    ghsaId: ghsa('eeee'),
    state: 'Closed',
    severity: 'high',
    reportedAt: '2026-03-02T00:00:00Z',
    comments: [
      comment({ author: 'samuelkarp', role: 'Member', at: '2026-03-02T02:00:00Z' }),
      comment({
        author: 'samuelkarp',
        role: 'Member',
        at: '2026-03-03T00:00:00Z',
        state: {
          betterGhsa: '1.0',
          seq: 1,
          by: 'samuelkarp',
          at: '2026-03-03T00:00:00Z',
          closure: { reason: 'not a vulnerability' },
        },
      }),
    ],
  });
  const doc = await page(
    corpusOf(
      [
        member({ ghsaId: ghsa('eeee'), state: 'closed', advisory: read }),
        member({ ghsaId: ghsa('ffff'), state: 'closed', severity: 'low' }),
        member({ ghsaId: ghsa('gggg'), state: 'published', severity: 'low' }),
      ],
      { complete: false, expected: { published: 4, closed: 1 } }
    )
  );

  assert.deepStrictEqual(
    textsOf(doc, `#${view.ROOT_ID} .bghsa-done-over span.Label`),
    ['Over 3 advisories', '2 unread', '5 on GitHub', view.PARTIAL_TEXT],
    'the corpus, what no read backs, what GitHub counted, and that the walk is unfinished'
  );

  // The closure reason is a stored value, so only the member a read backs can
  // carry one. The count says so rather than reading as one in three.
  const reason = one(doc, '[data-bghsa-count="reason"]');
  assert.strictEqual(textOf(reason, '.bghsa-done-meta'), '1 of 3');
  assert.deepStrictEqual(textsOf(reason, '.bghsa-done-tally > span'), [
    'Not a vulnerability',
    '1',
    '100%',
    'None',
    '2',
    '—',
  ]);

  // The severity comes off the list row where no read backs it, so every member
  // carries one and nothing is missing from that count.
  const severity = one(doc, '[data-bghsa-count="severity"]');
  assert.strictEqual(textOf(severity, '.bghsa-done-meta'), '3 of 3');
  assert.deepStrictEqual(textsOf(severity, '.bghsa-done-tally > span'), [
    'Low',
    '2',
    '67%',
    'High',
    '1',
    '33%',
  ]);

  const first = one(doc, '[data-bghsa-timing="firstResponse"]');
  assert.strictEqual(textOf(first, '.bghsa-done-meta'), '1 of 3, 2 omitted');
  assert.deepStrictEqual(textsOf(first, '.bghsa-done-spread span.bghsa-done-value'), [
    '2h 0m',
    '2h 0m',
    '2h 0m',
    '2h 0m',
  ]);

  const draft = one(doc, '[data-bghsa-timing="reportToDraft"]');
  assert.strictEqual(textOf(draft, '.bghsa-done-meta'), '0 of 3, 3 omitted');
  assert.deepStrictEqual(
    textsOf(draft, '.bghsa-done-spread span.bghsa-done-value'),
    ['—', '—', '—', '—'],
    'a timing nothing contributed to is a dash, and not a zero'
  );

  // Two of the three rows say nothing has read them.
  assert.deepStrictEqual(
    Array.from(doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`)).map(chipLine),
    ['Closed High', 'Closed Low Unread', 'Published Low Unread']
  );
});

test('the timing this extension cannot observe is named, not shown as zero', async () => {
  const doc = await page(corpusOf([member({ ghsaId: ghsa('hhhh'), state: 'closed' })]));
  const line = one(doc, '[data-bghsa-uncomputed="reportToClose"]');
  assert.strictEqual(textOf(line, 'span.text-bold'), 'Report to close:');
  assert.ok(
    (line.textContent ?? '').includes('is not measured'),
    `the reason the view gives: ${line.textContent}`
  );
  assert.strictEqual(
    doc.querySelector('[data-bghsa-timing="reportToClose"]'),
    null,
    'and it is not among the timings, so no number stands for it'
  );
});

/**
 * One comment on an advisory thread, in the shape the merge reads. A raw
 * payload makes it a state comment; no payload makes it an ordinary comment.
 *
 * @param {{ id: string, author: string, raw?: string }} fields
 * @returns {import('../src/common/parse-detail.js').ParsedComment}
 */
function comment(fields) {
  return {
    id: fields.id,
    elementId: `advisory-comment-${fields.id}`,
    author: fields.author,
    role: 'Member',
    roles: ['Member'],
    at: '2026-04-01T00:00:00Z',
    trusted: true,
    text: '',
    stateComment: fields.raw === undefined ? null : schema.readSnapshot(fields.raw),
  };
}

test('the reason an advisory carries is the reason its row shows', async () => {
  // The completed view exists to record and show a closure reason. Every other
  // test here reaches the reason through a control a maintainer moved, or
  // through a fixture that carries none, so the wiring from the advisory's own
  // stored state to the row it is drawn on is what this asserts.
  const closed = ghsa('gghh');
  const held = advisory({
    ref: { ...REF, ghsaId: closed },
    ghsaId: closed,
    state: 'Closed',
    comments: [
      comment({
        id: '77',
        author: 'samuelkarp',
        raw: JSON.stringify({
          betterGhsa: '1.0',
          seq: 1,
          by: 'samuelkarp',
          at: '2026-04-01T00:00:00Z',
          closure: { reason: 'not reproducible' },
        }),
      }),
    ],
  });
  const corpus = corpusOf([member({ ghsaId: closed, state: 'closed', advisory: held })]);

  assert.strictEqual(
    view.rowsOf(corpus).find((row) => row.ghsaId === closed)?.closureReason,
    'not reproducible',
    'the row the view builds carries no reason off the advisory'
  );

  const doc = await page(corpus);
  const control = one(doneRow(doc, closed), 'select.bghsa-done-reason');
  const chosen = Array.from(control.querySelectorAll('option'))
    .filter((option) => option.hasAttribute('selected'))
    .map((option) => option.getAttribute('value'));
  assert.deepStrictEqual(chosen, ['not reproducible'], 'the control shows another reason');
});

test('a closure reason set here goes out through the stored write path', async () => {
  const read = parseDetail.parseDetail(document(fixture('triage-thread.html')));
  assert.ok(read !== null && read.ref !== null, 'the fixture reads as an advisory');
  const held = await cachedCorpus([{ ghsaId: TRIAGE_ID, state: 'closed', record: read }]);
  const built = view.memberOf(held, TRIAGE_ID)?.advisory ?? null;
  assert.ok(built !== null, 'the cached entry read back as an advisory');
  assert.notStrictEqual(built, read, 'the member carries the read back, not the parse');
  assert.strictEqual(built.ref?.owner, REF.owner, 'which names the repository it is on');
  assert.strictEqual(built.ref?.ghsaId, TRIAGE_ID, 'and the advisory it is of');
  const doc = await page(held);

  const row = doneRow(doc, TRIAGE_ID);
  const control = one(row, 'select.bghsa-done-reason');
  const save = one(row, 'button.bghsa-done-save');
  assert.ok(
    !save.hasAttribute('disabled'),
    'a member the cache backs can be written from here'
  );
  assert.deepStrictEqual(
    Array.from(control.querySelectorAll('option')).map((node) => node.getAttribute('value')),
    ['', ...schema.CLOSURE_REASONS],
    'the control offers the reasons the schema knows'
  );

  choose(control, 'not a vulnerability');

  /** @type {import('../src/detail/edit.js').EditorContext[]} */
  const saved = [];
  /** @type {() => void} */
  let landed = () => {};
  const settled = new Promise((resolve) => {
    landed = () => resolve(undefined);
  });
  const realSave = edit.save;
  edit.save = async (context) => {
    saved.push(context);
    landed();
    return { ok: true, reason: null, status: 200, message: 'saved', snapshot: null, merged: null };
  };
  try {
    /** @type {HTMLElement} */ (/** @type {unknown} */ (save)).click();
    await Promise.race([
      settled,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no save was asked for')), 2000)),
    ]);
  } finally {
    edit.save = realSave;
  }

  assert.strictEqual(saved.length, 1, 'the press went to the editing store, not to a writer here');
  const context = /** @type {import('../src/detail/edit.js').EditorContext} */ (saved[0]);
  assert.strictEqual(context.advisory, built, 'the save is against the advisory the view holds');
  const key = edit.keyOf(built);
  assert.strictEqual(
    key,
    `${REF.owner}/${REF.repo}/${TRIAGE_ID}`.toLowerCase(),
    'staged under the key the detail panel uses, so one advisory has one entry'
  );
  assert.strictEqual(edit.editsFor(key).closureReason, 'not a vulnerability');
  // The snapshot that write would carry, built by the writer's own builder.
  assert.deepStrictEqual(
    edit.changesOf(context.tracking, context.fingerprints, edit.editsFor(key), {
      by: 'samuelkarp',
      at: '2026-08-27T12:00:00Z',
    }),
    { closure: { reason: 'not a vulnerability' } }
  );
  edit.edits.delete(key);
});

test('a reason a maintainer sets reaches GitHub as a state comment', async () => {
  const page_html = fixture('triage-thread.html');
  const read = parseDetail.parseDetail(document(page_html));
  assert.ok(read !== null, 'the fixture reads as an advisory');
  const held = await cachedCorpus([{ ghsaId: TRIAGE_ID, state: 'closed', record: read }]);
  const built = view.memberOf(held, TRIAGE_ID)?.advisory ?? null;
  assert.ok(built !== null, 'the cached entry read back as an advisory');
  const doc = await page(held);

  /** @type {URLSearchParams[]} */
  const posted = [];
  const outcome = await view.setReason(doc, TRIAGE_ID, 'out of scope', {
    fetch: async (url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { status: 200, text: async () => page_html };
      const body = /** @type {URLSearchParams} */ (/** @type {unknown} */ (init.body));
      posted.push(body);
      const markdown = body.get('body') ?? body.get(write.EDIT_BODY_FIELD) ?? '';
      const marker = /`([^`\n]+)`/.exec(markdown)?.[1] ?? '';
      const fence = /```json\n([\s\S]*?)\n```/.exec(markdown)?.[1] ?? '';
      const escape = /** @param {string} value */ (value) =>
        value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return {
        status: 200,
        text: async () =>
          '<!doctype html><html><body>' +
          '<div class="comment-body markdown-body js-comment-body"><details>' +
          `<summary>${schema.STATE_COMMENT_SUMMARY}</summary>` +
          `<p><code>${escape(marker)}</code></p>` +
          `<div class="highlight highlight-source-json"><pre>${escape(fence)}</pre></div>` +
          '</details></div></body></html>',
      };
    },
    parseDocument: (html) => document(html),
  });

  assert.ok(outcome !== null && outcome.ok, `the write: ${outcome?.message}`);
  assert.strictEqual(posted.length, 1, 'one comment went out');
  const markdown = posted[0]?.get('body') ?? posted[0]?.get(write.EDIT_BODY_FIELD) ?? '';
  const snapshot = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(markdown)?.[1] ?? '{}');
  assert.deepStrictEqual(
    snapshot.closure,
    { reason: 'out of scope' },
    `the snapshot GitHub was sent: ${markdown}`
  );
  edit.edits.delete(edit.keyOf(built));
  edit.written.delete(edit.keyOf(built));
  edit.results.delete(edit.keyOf(built));
});

test('an advisory nothing has read takes no reason and says why', async () => {
  const doc = await page(await cachedCorpus([{ ghsaId: ghsa('iiii'), state: 'closed' }]));
  const row = doneRow(doc, ghsa('iiii'));
  assert.ok(
    one(row, 'button.bghsa-done-save').hasAttribute('disabled'),
    'the control cannot write what nothing has read'
  );

  const outcome = await view.setReason(doc, ghsa('iiii'), 'out of scope');
  assert.strictEqual(outcome, null, 'nothing was written');
  assert.strictEqual(
    textOf(doneRow(doc, ghsa('iiii')), '.bghsa-done-note'),
    view.UNREADABLE_MESSAGE
  );
  view.notes.clear();
});

test('the export is the corpus, written here in the page', async () => {
  const empty = await page();
  assert.ok(
    one(empty, `#${view.ROOT_ID} button.bghsa-done-export`).hasAttribute('disabled'),
    'there is nothing to export before a corpus is held'
  );

  const doc = await page(
    corpusOf([
      member({
        ghsaId: ghsa('jjjj'),
        state: 'published',
        title: 'A published advisory',
        severity: 'high',
        openedAt: '2026-03-02T00:00:00Z',
      }),
    ])
  );
  assert.ok(
    !one(doc, `#${view.ROOT_ID} button.bghsa-done-export`).hasAttribute('disabled'),
    'and there is once one is'
  );

  /** @type {unknown[]} */
  const parts = [];
  class FakeBlob {
    /** @param {unknown[]} pieces */
    constructor(pieces) {
      parts.push(...pieces);
    }
  }
  const url = view.exportCsv(doc, {
    Blob: /** @type {typeof globalThis.Blob} */ (/** @type {unknown} */ (FakeBlob)),
    createObjectURL: () => 'blob:https://github.com/done',
    revokeObjectURL: () => {},
  });

  assert.strictEqual(url, 'blob:https://github.com/done');
  const text = /** @type {string} */ (parts[0]);
  const lines = text.split('\r\n');
  assert.strictEqual(lines[0], csv.COLUMNS.join(','));
  assert.strictEqual(
    lines[1],
    `${ghsa('jjjj')},A published advisory,published,high,,2026-03-02T00:00:00Z,2026-03,,,no,`
  );
});

test('a second visit to the done view spends no request on the corpus', async () => {
  const published = [ghsa('kkkk'), ghsa('llll')];
  const closed = [ghsa('mmmm')];
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids: published,
    counts: { published: 2, closed: 1 },
  });
  pages[`${base}?state=closed`] = listHtml({
    state: 'closed',
    ids: closed,
    counts: { published: 2, closed: 1 },
  });
  for (const id of published) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  for (const id of closed) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Closed',
      reportedAt: '2026-04-05T00:00:00Z',
    });
  }

  // An earlier test in this file walked these states through the same storage,
  // and a walk inside its threshold is not walked again. This is the first
  // visit a maintainer with an empty cache makes.
  await cache.clear();

  const first = await page();
  const before = asked.length;
  await view.collect(first);
  assert.strictEqual(
    asked.length - before,
    published.length + closed.length + 2,
    'the first visit reads both list pages and every advisory they name'
  );

  // The maintainer comes back an hour later: another page load, another
  // document, and the cache the first visit filled. On one five-minute
  // threshold this is the whole corpus again, at a request a second.
  clockAt += 60 * MINUTE;
  const second = await page();
  const at = asked.length;
  const held = await view.collect(second);
  assert.strictEqual(asked.length - at, 0, `the second visit asked for ${asked.slice(at)}`);
  assert.strictEqual(held?.members.length, 3, 'and it still drew the whole corpus');
  assert.deepStrictEqual(held?.unread, [], 'every row backed by a read, from the cache alone');
});

test("a corpus is not drawn under the repository the maintainer moved to", async () => {
  const other = { owner: 'git-utensils', repo: 'Fork-Knife' };
  const doc = await page(await cachedCorpus([{ ghsaId: ghsa('nnnn'), state: 'closed' }]));
  assert.strictEqual(
    doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`).length,
    1,
    'the corpus is drawn on the repository it was collected on'
  );
  assert.strictEqual(table.refOf(doc)?.repo, REF.repo, 'which is the one the page names');

  // GitHub replaces the turbo frame on a soft navigation and keeps the
  // document. The page now names another repository.
  one(doc, '#repo-content-turbo-frame').innerHTML = listHtml({
    state: 'published',
    ids: [ghsa('oooo')],
  }).replaceAll(`/${REF.owner}/${REF.repo}/`, `/${other.owner}/${other.repo}/`);
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');
  assert.strictEqual(table.refOf(doc)?.repo, other.repo, 'the page names the repository moved to');

  assert.strictEqual(
    doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`).length,
    0,
    "the previous repository's rows are drawn under the new page"
  );
  assert.strictEqual(
    textOf(doc, `#${view.ROOT_ID} .bghsa-done-count`),
    '0 advisories',
    'and its count with them'
  );
  assert.ok(
    one(doc, `#${view.ROOT_ID} button.bghsa-done-export`).hasAttribute('disabled'),
    'and the export offers a file of them'
  );
  assert.strictEqual(view.exportCsv(doc), null, 'a file of them can still be asked for');
  assert.strictEqual(view.stateOf(doc).corpus, null, 'the view is still holding them');
});
