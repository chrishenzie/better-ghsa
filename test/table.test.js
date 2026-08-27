'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML, DOMParser } = require('linkedom');

const parseList = require('../src/common/parse-list.js');
const parseDetail = require('../src/common/parse-detail.js');
const cache = require('../src/common/cache.js');
const order = require('../src/common/order.js');
const table = require('../src/list/table.js');

const { fakeStorage } = require('../test-support/storage.js');

/** The moment every render in this file reads the page at. */
const AT = Date.parse('2026-08-26T12:00:00Z');

/** The moment the cached advisory reads in this file were taken at. */
const OBSERVED = Date.parse('2026-08-26T10:00:00Z');

/**
 * The clock every render and every queue here reads. A refresh moves it, so it
 * is a variable rather than a constant, and a test that moves it puts it back.
 */
let clockAt = AT;

cache.setClock(() => clockAt);

// The queue and the crawl turn a fetched page into a document the way a content
// script does. Nothing in this file reaches the network: every response is a
// string a test wrote.
globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

const MINUTE = 60 * 1000;

/** The repository both list fixtures come from. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

/**
 * @param {string} name
 * @returns {string} one fixture's markup.
 */
function fixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
}

/**
 * The list fixture inside the frame GitHub replaces on a soft navigation, which
 * is what the observer watches and what a re-render has to survive.
 *
 * @param {string} name
 * @returns {Document}
 */
function listPage(name) {
  const html = [
    '<!doctype html><html><head></head><body>',
    '<div id="repo-content-turbo-frame">',
    fixture(name),
    '</div></body></html>',
  ].join('');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * One advisory as the cache holds it: a parsed detail page, put through JSON the
 * way `browser.storage.local` puts it.
 *
 * @param {string} name
 * @returns {unknown}
 */
function storedAdvisory(name) {
  const html = fixture(name);
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const record = parseDetail.parseDetail(doc);
  if (record === null) throw new Error(`${name} is not an advisory detail page`);
  return JSON.parse(JSON.stringify(record));
}

/** The one parse of each large fixture in this file. */
const TRIAGE_RECORD = storedAdvisory('triage-thread.html');
const DRAFT_RECORD = storedAdvisory('draft.html');

/**
 * @param {string} ghsaId
 * @returns {string} the key that advisory's cache entry is held under.
 */
function keyFor(ghsaId) {
  const key = cache.advisoryKey({ ...REF, ghsaId });
  if (key === null) throw new Error(`no cache key for ${ghsaId}`);
  return key;
}

/**
 * @param {unknown} record
 * @param {string} state
 * @returns {import('../src/common/cache.js').CacheEntry}
 */
function entryOf(record, state) {
  return { record, observedAt: OBSERVED, state };
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
 * @returns {string} the matched element's text, whitespace collapsed.
 */
function textOf(scope, selector) {
  return (one(scope, selector).textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Every chip under one row's title, as one line. A chip carrying a tone names it
 * in brackets, so one string covers both what the chips read and which of them
 * are coloured.
 *
 * @param {Element} row
 * @returns {string}
 */
function chipLine(row) {
  return Array.from(one(row, '.bghsa-list-chips').querySelectorAll('span.Label'))
    .map((label) => {
      const text = (label.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (label.classList.contains('bghsa-tone-danger')) return `${text}[danger]`;
      if (label.classList.contains('bghsa-tone-attention')) return `${text}[attention]`;
      return text;
    })
    .join(' | ');
}

/**
 * @param {Document} doc
 * @returns {Element[]} the extension's rows.
 */
function tableRows(doc) {
  return Array.from(doc.querySelectorAll(`#${table.ROOT_ID} li.bghsa-list-row`));
}

/**
 * @param {Document} doc
 * @param {Record<string, unknown>} [held] What the cache holds for this render.
 * @returns {Promise<Element>} the table this page renders to.
 */
async function render(doc, held = {}) {
  cache.setStorage(fakeStorage(held));
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');
  return root;
}

/**
 * @param {Document} doc
 * @returns {HTMLElement} the toggle between the two views.
 */
function toggleIn(doc) {
  return /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-list-toggle`))
  );
}

test("a triage row carries what GitHub's row carried, from the list markup alone", async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc);

  const rows = tableRows(doc);
  assert.ok(rows.length === 1, `rows on the triage page: ${rows.length}`);
  const row = /** @type {Element} */ (rows[0]);

  const link = one(row, 'a.Link--primary');
  const title = (link.textContent ?? '').trim();
  assert.ok(
    title === 'Path traversal in drawer handler allows reading arbitrary files',
    `title: ${title}`
  );
  const href = link.getAttribute('href');
  assert.ok(
    href === '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj',
    `href: ${href}`
  );

  const meta = textOf(row, '.bghsa-list-meta');
  assert.ok(meta === 'GHSA-jmvx-2wfw-xfgj opened 2026-08-25 by prakleumas', `meta line: ${meta}`);

  const state = textOf(row, '.bghsa-list-state');
  assert.ok(state === 'Triage', `state: ${state}`);

  const chips = chipLine(row);
  assert.ok(chips === 'High', `chips with nothing read: ${chips}`);

  const observed = textOf(row, '.bghsa-list-observed');
  assert.ok(observed === 'Observed 2026-08-26 12:00 UTC', `observed: ${observed}`);

  assert.ok(row.querySelector('.bghsa-list-owners') === null, 'an unowned row shows no owner icon');
});

test('a cached advisory read fills the triage row', async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc, { [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(TRIAGE_RECORD, 'triage') });

  const row = /** @type {Element} */ (tableRows(doc)[0]);
  const chips = chipLine(row);
  assert.ok(
    chips ===
      'Blocked on the reporter | Patch in review | Backports 0 of 1 | High, unconfirmed |' +
        ' Embargo lifts 2026-09-30[attention]',
    `chips from the cached read: ${chips}`
  );

  const owner = one(row, '.bghsa-list-owners a');
  const ownerHref = owner.getAttribute('href');
  assert.ok(ownerHref === '/samuelkarp', `owner link: ${ownerHref}`);
  const avatar = one(owner, 'img.avatar.avatar-user');
  const alt = avatar.getAttribute('alt');
  assert.ok(alt === '@samuelkarp', `owner avatar alt text: ${alt}`);
  const title = avatar.getAttribute('title');
  assert.ok(title === 'samuelkarp', `owner avatar title: ${title}`);
  const width = avatar.getAttribute('width');
  assert.ok(width === '20', `owner avatar width: ${width}`);
  // An owner login arrives with no account id beside it, so the icon is asked
  // for by login. GitHub redirects that to the id-keyed avatar the captures
  // carry, at twice the drawn size.
  const src = avatar.getAttribute('src');
  assert.ok(
    src === 'https://github.com/samuelkarp.png?size=40',
    `owner avatar source: ${src}`
  );

  const observed = textOf(row, '.bghsa-list-observed');
  assert.ok(observed === 'Observed 2026-08-26 10:00 UTC', `observed: ${observed}`);
});

test('an owner login is encoded the same way in the link and the avatar', () => {
  const doc = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML('<!doctype html><html><body></body></html>').document)
  );
  // The login comes from a state comment, which is text anyone who can comment
  // on the advisory can write. It reaches the page twice from one string, so
  // both places encode it the same way.
  const box = table.buildOwners(doc, ['a b/c?d#e']);
  const link = one(box, 'a');
  const href = link.getAttribute('href');
  assert.ok(href === '/a%20b%2Fc%3Fd%23e', `owner link: ${href}`);
  const src = one(link, 'img').getAttribute('src');
  assert.ok(
    src === 'https://github.com/a%20b%2Fc%3Fd%23e.png?size=40',
    `owner avatar source: ${src}`
  );
});

test("the table holds GitHub's segmented control, rows, and query form out of view", async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc);

  const container = one(doc, '#advisories');
  const controls = table.nativeControls(container);
  assert.ok(controls.length === 2, `controls the table hides: ${controls.length}`);

  const box = /** @type {Element} */ (controls[0]);
  assert.ok(box.querySelector('segmented-control') !== null, 'the hidden Box holds the tabs');
  assert.ok(
    box.querySelector('div.Box-row--drag-hide') !== null,
    "the hidden Box holds GitHub's rows, so restoring them is one act"
  );
  const filter = /** @type {Element} */ (controls[1]);
  assert.ok(
    filter.tagName.toLowerCase() === 'repository-advisories-filter',
    `the second control: ${filter.tagName}`
  );

  for (const control of controls) {
    assert.ok(
      control.classList.contains(table.HIDDEN_CLASS),
      `${control.tagName} is out of view while the table shows`
    );
    assert.ok(
      control.closest(`#${table.ROOT_ID}`) === null,
      'the table never hides anything of its own'
    );
  }
});

test('injecting twice leaves one table and one stylesheet', async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc);
  await render(doc);

  const roots = doc.querySelectorAll(`#${table.ROOT_ID}`).length;
  assert.ok(roots === 1, `tables after two injections: ${roots}`);
  const styles = doc.querySelectorAll(`style#${table.STYLE_ID}`).length;
  assert.ok(styles === 1, `stylesheets after two injections: ${styles}`);
  const rows = tableRows(doc).length;
  assert.ok(rows === 1, `rows after two injections: ${rows}`);
});

test('a render after GitHub replaced the subtree puts the table back', async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc);

  // A soft navigation replaces the frame contents, and the table goes with them.
  const frame = one(doc, '#repo-content-turbo-frame');
  const fresh = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML(`<div>${fixture('list-page-triage.html')}</div>`).document)
  );
  one(doc, '#advisories').replaceWith(one(fresh, '#advisories'));

  assert.ok(doc.getElementById(table.ROOT_ID) === null, 'the replacement took the table with it');
  assert.ok(table.outOfPlace(doc), 'the document is asking for a pass');
  assert.ok(frame.querySelector('#advisories') !== null, 'the fresh list is in the frame');

  await render(doc);
  const roots = doc.querySelectorAll(`#${table.ROOT_ID}`).length;
  assert.ok(roots === 1, `tables after the replacement: ${roots}`);
  const rows = tableRows(doc).length;
  assert.ok(rows === 1, `rows after the replacement: ${rows}`);
});

test('a table left behind at the wrong place is put back', async () => {
  const doc = listPage('list-page-triage.html');
  const root = await render(doc);
  assert.ok(!table.outOfPlace(doc), 'a fresh injection sits at the anchor');

  one(doc, '#advisories').append(root);
  assert.ok(table.outOfPlace(doc), 'a table moved off the anchor is out of place');

  await render(doc);
  assert.ok(!table.outOfPlace(doc), 'the pass put it back');
  const roots = doc.querySelectorAll(`#${table.ROOT_ID}`).length;
  assert.ok(roots === 1, `tables after the pass: ${roots}`);
});

test('parse-list cannot read the table the extension inserts', async () => {
  const doc = listPage('list-page-triage.html');
  const before = parseList.parseList(doc);
  if (before === null) throw new Error('the fixture is not a list page');

  const root = await render(doc);

  const after = parseList.parseList(doc);
  if (after === null) throw new Error('the injected page stopped reading as a list page');
  assert.ok(after.rows.length === before.rows.length, `rows re-read: ${after.rows.length}`);
  const title = after.rows[0]?.title ?? null;
  assert.ok(title === (before.rows[0]?.title ?? null), `the row re-read: ${title}`);
  assert.ok(after.tabs.length === before.tabs.length, `tabs re-read: ${after.tabs.length}`);
  assert.ok(after.next === null, 'the table adds no next page');

  // The parser keys on these three inside `div#advisories`. The table carries
  // none of them, which is what keeps a re-read from taking its rows for
  // GitHub's own.
  const matched = root.querySelectorAll(table.PARSED_SELECTORS.join(', ')).length;
  assert.ok(matched === 0, `nodes in the table the parser would read: ${matched}`);
});

test('the default order puts the longest waiting first', async () => {
  /** @type {import('../src/common/parse-list.js').ParsedList} */
  const parsed = {
    ...REF,
    rows: [
      listRow('GHSA-bbbb-bbbb-bbbb', '2026-08-20T00:00:00Z'),
      listRow('GHSA-aaaa-aaaa-aaaa', '2026-08-01T00:00:00Z'),
      listRow('GHSA-cccc-cccc-cccc', '2026-08-10T00:00:00Z'),
    ],
    tabs: [],
    selectedState: 'triage',
    next: null,
    openCount: 3,
  };
  cache.setStorage(fakeStorage());
  const view = await table.readView(parsed, { at: AT });
  const order = view.rows.map((row) => row.ghsaId).join(' ');
  assert.ok(
    order === 'GHSA-aaaa-aaaa-aaaa GHSA-cccc-cccc-cccc GHSA-bbbb-bbbb-bbbb',
    `default order: ${order}`
  );
});

/**
 * @param {string} ghsaId
 * @param {string} openedAt
 * @returns {import('../src/common/parse-list.js').ListRow}
 */
function listRow(ghsaId, openedAt) {
  return {
    ghsaId,
    owner: REF.owner,
    repo: REF.repo,
    href: `/${REF.owner}/${REF.repo}/security/advisories/${ghsaId}`,
    title: ghsaId,
    state: 'Triage',
    severity: null,
    severityLabel: null,
    openedAt,
    reporter: 'prakleumas',
  };
}

/**
 * @param {Partial<import('../src/list/table.js').TableRow>} [changes]
 * @returns {import('../src/list/table.js').TableRow}
 */
function rowWith(changes = {}) {
  return { ...table.unreadRow(listRow('GHSA-aaaa-aaaa-aaaa', '2026-08-01T00:00:00Z'), AT), ...changes };
}

/**
 * @param {Partial<import('../src/list/table.js').TableRow>} [changes]
 * @returns {string}
 */
function chipsOf(changes = {}) {
  return table
    .chipsFor(rowWith(changes))
    .map((spec) => (spec.tone === undefined ? spec.text : `${spec.text}[${spec.tone}]`))
    .join(' | ');
}

test('a chip stands for a condition that holds and is absent when it does not', () => {
  const none = chipsOf();
  assert.ok(none === '', `a row with nothing to say: ${none}`);

  const reviewed = chipsOf({ read: true, neverReviewed: true });
  assert.ok(reviewed === 'Never reviewed[danger]', `never reviewed: ${reviewed}`);

  const activity = chipsOf({ read: true, newActivity: true });
  assert.ok(activity === 'New activity[attention]', `new activity: ${activity}`);

  const blocked = chipsOf({ read: true, triage: 'evaluating' });
  assert.ok(blocked === 'Blocked on us', `a state the advisory is simply in stays dimmed: ${blocked}`);

  const text = chipsOf({ read: true, textConfirmed: true });
  assert.ok(text === 'Blocked on us | Text confirmed', `text confirmed: ${text}`);

  // An unconfirmed track says nothing, so no chip reads `label: no`.
  const unconfirmed = chipsOf({ read: true, textConfirmed: false });
  assert.ok(unconfirmed === 'Blocked on us', `text unconfirmed: ${unconfirmed}`);
});

test('the severity chip carries the scoring confirmation', () => {
  const unread = chipsOf({ severityLabel: 'Critical' });
  assert.ok(unread === 'Critical', `nothing read, so nothing is claimed: ${unread}`);

  const unconfirmed = chipsOf({ read: true, severityLabel: 'Critical' });
  assert.ok(
    unconfirmed === 'Blocked on us | Critical, unconfirmed',
    `severity nobody confirmed: ${unconfirmed}`
  );

  const confirmed = chipsOf({ read: true, severityLabel: 'Low', severityConfirmed: true });
  assert.ok(confirmed === 'Blocked on us | Low, confirmed', `severity a maintainer confirmed: ${confirmed}`);

  // With no severity set there is no chip for the mark to ride, so it stands
  // alone rather than going unsaid.
  const noSeverity = chipsOf({ read: true, severityConfirmed: true });
  assert.ok(noSeverity === 'Blocked on us | Scoring confirmed', `no severity set: ${noSeverity}`);
});

test('the CVE, patch, backport, and embargo chips read what the advisory holds', () => {
  const assigned = chipsOf({ read: true, cve: 'CVE-2026-12345' });
  assert.ok(assigned === 'Blocked on us | CVE-2026-12345', `an assigned CVE: ${assigned}`);

  const patch = chipsOf({ read: true, patch: 'Patch merged' });
  assert.ok(patch === 'Blocked on us | Patch merged', `patch state: ${patch}`);

  const backports = chipsOf({ read: true, backportTargets: 3, backportsDone: 2 });
  assert.ok(backports === 'Blocked on us | Backports 2 of 3', `backport progress: ${backports}`);

  const embargo = chipsOf({ read: true, embargo: true, embargoLift: '2026-09-30' });
  assert.ok(
    embargo === 'Blocked on us | Embargo lifts 2026-09-30[attention]',
    `an embargo in force: ${embargo}`
  );

  const undated = chipsOf({ read: true, embargo: true });
  assert.ok(undated === 'Blocked on us | Embargoed[attention]', `an embargo with no date: ${undated}`);

  const overdue = chipsOf({ read: true, embargo: true, embargoLift: '2026-08-01', embargoOverdue: true });
  assert.ok(
    overdue === 'Blocked on us | Embargo overdue[danger]',
    `an embargo a maintainer has to act on: ${overdue}`
  );
});

test('the patch chip says nothing about a pull request whose state went unread', () => {
  const unread = table.patchStateOf({
    hasFork: true,
    pullRequests: [
      { number: 1, url: null, title: 'p', state: null, baseRef: 'main', headRef: null, author: null, openedAt: null, assignees: [] },
    ],
    branches: [],
    merged: [],
    open: [],
    closed: [],
    unknown: [1],
    incomplete: true,
  });
  assert.ok(unread === null, `a patch state this reader cannot judge: ${unread}`);
});

test('a cache record this reader cannot use answers as absent', () => {
  assert.ok(table.advisoryFrom(null) === null, 'null is not an advisory');
  assert.ok(table.advisoryFrom('advisory') === null, 'a string is not an advisory');
  assert.ok(table.advisoryFrom({ ghsaId: 'GHSA-x' }) === null, 'a record with no comment list');
  assert.ok(table.advisoryFrom({ comments: [], timeline: {} }) === null, 'a record with no timeline');
});

test("an author's standing in a cache record is recomputed, not read", () => {
  const advisory = table.advisoryFrom({
    comments: [
      { id: '1', elementId: 'advisory-comment-1', author: 'prakleumas', role: 'Author', trusted: true },
      { id: '2', elementId: 'advisory-comment-2', author: 'samuelkarp', role: 'Member', trusted: false },
    ],
    timeline: [],
  });
  if (advisory === null) throw new Error('the record did not read as an advisory');
  const reporter = advisory.comments[0]?.trusted ?? null;
  assert.ok(reporter === false, `a reporter stored as trusted: ${reporter}`);
  const member = advisory.comments[1]?.trusted ?? null;
  assert.ok(member === true, `a member stored as untrusted: ${member}`);
});

test('a page that is not an advisory list gets no table', async () => {
  const doc = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML('<!doctype html><html><body><div id="x"></div></body></html>').document)
  );
  cache.setStorage(fakeStorage());
  const root = await table.render(doc);
  assert.ok(root === null, 'nothing to render into');
  assert.ok(doc.getElementById(table.ROOT_ID) === null, 'and nothing rendered');
});

/**
 * One page of the advisory list for a repository this file invents, in the
 * shape `parse-list` reads. The repository differs per test so that no two
 * tests share a refresh queue.
 *
 * @param {{ owner: string, repo: string, state: string, ids: readonly string[], next?: string }} page
 * @returns {string}
 */
function listHtml(page) {
  const label = /** @type {string} */ (parseList.STATES[page.state]);
  const base = `/${page.owner}/${page.repo}/security/advisories`;
  const tabs = Object.entries(parseList.STATES)
    .map(
      ([state, name]) =>
        `<li><a href="${base}?state=${state}"${
          state === page.state ? ' aria-current="true"' : ''
        }>1 ${name}</a></li>`
    )
    .join('');
  const rows = page.ids
    .map(
      (id) =>
        '<div class="Box-row Box-row--drag-hide">' +
        `<a class="Link--primary" href="${base}/${id}">Title ${id}</a>` +
        `<span class="tooltipped" aria-label="${label} advisory"></span>` +
        '<span class="opened-by">opened <relative-time datetime="2026-08-01T00:00:00Z">' +
        '</relative-time> by <a class="author" href="/prakleumas">prakleumas</a></span>' +
        '</div>'
    )
    .join('');
  const next = page.next === undefined ? '' : `<a rel="next" href="${page.next}">Next</a>`;
  return (
    `<div id="advisories"><segmented-control><ul>${tabs}</ul></segmented-control>` +
    `<div class="Box">${rows}</div>${next}</div>`
  );
}

/**
 * The smallest document `parse-detail` reads as an advisory: the header meta
 * carrying the state, the severity, and the identifier. A row filled in from
 * one of these carries what a read supplies and nothing the fixtures add.
 *
 * @param {string} ghsaId
 * @param {string} state
 * @param {string} [severity]
 * @returns {string}
 */
function detailHtml(ghsaId, state, severity = 'High') {
  return (
    '<!doctype html><html><body><div class="gh-header-meta">' +
    `<span class="State">${state}</span>` +
    `<span class="Label Label--large" title="Severity: ${severity}">${severity}</span>` +
    `<span class="user-select-contain">${ghsaId}</span>` +
    '</div></body></html>'
  );
}

/**
 * @param {string} ghsaId
 * @param {string} state
 * @param {string} [severity]
 * @returns {unknown} that advisory as the cache holds it.
 */
function storedDetail(ghsaId, state, severity) {
  const doc = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML(detailHtml(ghsaId, state, severity)).document)
  );
  const record = parseDetail.parseDetail(doc);
  if (record === null) throw new Error(`${ghsaId} did not read as an advisory`);
  return JSON.parse(JSON.stringify(record));
}

/**
 * A fetch that answers from a table of pages and records what was asked for.
 *
 * @param {Record<string, string>} pages
 */
function fakeFetch(pages) {
  /** @type {string[]} */
  const urls = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    urls.push(String(url));
    const body = pages[String(url)];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  };
  return { urls, send };
}

/**
 * The wait a refresh here spends between requests: it moves the clock and
 * returns, so a pass costs no real time and the intervals are still exact.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function advance(ms) {
  clockAt += ms;
}

/**
 * @param {string} html
 * @returns {Document}
 */
function pageOf(html) {
  return /** @type {Document} */ (
    /** @type {unknown} */ (
      parseHTML(`<!doctype html><html><body><div id="repo-content-turbo-frame">${html}</div></body></html>`)
        .document
    )
  );
}

test('a read lands in the row where it stands', async () => {
  const owner = 'crawl-place';
  const ghsaId = 'GHSA-aaaa-aaaa-aaaa';
  const doc = pageOf(listHtml({ owner, repo: 'repo', state: 'triage', ids: [ghsaId] }));
  const storage = fakeStorage();
  cache.setStorage(storage);
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');

  assert.ok(chipLine(/** @type {Element} */ (tableRows(doc)[0])) === '', 'an unread row has chips');

  const detail = parseDetail.parseDetail(
    /** @type {Document} */ (/** @type {unknown} */ (parseHTML(detailHtml(ghsaId, 'Triage')).document))
  );
  const applied = await table.applyEntry(doc, ghsaId, {
    record: detail,
    observedAt: AT - 30 * MINUTE,
    state: 'triage',
  });

  assert.ok(applied, 'no row was replaced');
  // The table around the row is untouched: a pass reads one advisory a second,
  // and a reader looking at the table keeps what they were looking at.
  assert.ok(doc.getElementById(table.ROOT_ID) === root, 'the whole table was rebuilt');
  const rows = tableRows(doc);
  assert.ok(rows.length === 1, `rows after the read: ${rows.length}`);
  const row = /** @type {Element} */ (rows[0]);
  assert.ok(
    chipLine(row) === 'Never reviewed[danger] | High, unconfirmed',
    `chips after the read: ${chipLine(row)}`
  );
  const observed = textOf(row, '.bghsa-list-observed');
  assert.ok(observed === 'Observed 2026-08-26 11:30 UTC', `observed: ${observed}`);
});

test('a read for an advisory the table is not showing replaces nothing', async () => {
  const doc = pageOf(
    listHtml({ owner: 'crawl-absent', repo: 'repo', state: 'triage', ids: ['GHSA-aaaa-aaaa-aaaa'] })
  );
  cache.setStorage(fakeStorage());
  await table.render(doc);
  const applied = await table.applyEntry(doc, 'GHSA-zzzz-zzzz-zzzz', {
    record: { state: 'Triage' },
    observedAt: AT,
    state: 'triage',
  });
  assert.ok(!applied, 'a row was replaced for an advisory the table does not hold');
});

test('a refresh crawls both open states and fills every row in', async () => {
  const owner = 'crawl-union';
  const repo = 'repo';
  const base = `/${owner}/${repo}/security/advisories`;
  const triage = 'GHSA-aaaa-aaaa-aaaa';
  const draft = 'GHSA-bbbb-bbbb-bbbb';
  const doc = pageOf(listHtml({ owner, repo, state: 'triage', ids: [triage] }));
  const storage = fakeStorage();
  cache.setStorage(storage);
  const fetch = fakeFetch({
    [`${base}?state=draft`]: listHtml({ owner, repo, state: 'draft', ids: [draft] }),
    [`${base}/${triage}`]: detailHtml(triage, 'Triage'),
    [`${base}/${draft}`]: detailHtml(draft, 'Draft'),
  });

  const started = clockAt;
  try {
    await table.render(doc);
    assert.ok(tableRows(doc).length === 1, 'the first paint showed more than the page carried');

    const summary = await table.refresh(doc, {
      storage,
      fetch: fetch.send,
      wait: advance,
      href: `https://github.com${base}?state=triage`,
    });

    // The page being looked at is the first page of triage, so the walk asks
    // for the other open state and for the two advisories, and for nothing it
    // already has.
    assert.deepStrictEqual(fetch.urls, [
      `${base}?state=draft`,
      `${base}/${triage}`,
      `${base}/${draft}`,
    ]);
    assert.ok(summary !== null && summary.read.fetched === 2, 'both advisories were not read');

    const rows = tableRows(doc);
    assert.ok(rows.length === 2, `rows after the refresh: ${rows.length}`);
    const ids = rows.map((row) => row.getAttribute('data-bghsa-ghsa')).sort();
    assert.deepStrictEqual(ids, [triage, draft].sort());
    const chips = new Map(rows.map((row) => [row.getAttribute('data-bghsa-ghsa'), chipLine(row)]));
    assert.ok(
      chips.get(triage) === 'Never reviewed[danger] | High, unconfirmed',
      `the triage row after the refresh: ${chips.get(triage)}`
    );
    // A draft is a maintainer's own writing, so nobody is waiting on a review
    // of it and it is the maintainers who are holding it.
    assert.ok(
      chips.get(draft) === 'Blocked on us | High, unconfirmed',
      `the draft row after the refresh: ${chips.get(draft)}`
    );
  } finally {
    clockAt = started;
  }
});

test('an advisory observed four minutes ago is not read again', async () => {
  const owner = 'crawl-fresh';
  const repo = 'repo';
  const base = `/${owner}/${repo}/security/advisories`;
  const fresh = 'GHSA-aaaa-aaaa-aaaa';
  const stale = 'GHSA-bbbb-bbbb-bbbb';
  const doc = pageOf(listHtml({ owner, repo, state: 'triage', ids: [fresh, stale] }));
  const storage = fakeStorage();
  cache.setStorage(storage);
  const started = clockAt;
  try {
    await cache.putAdvisory(
      { owner, repo, ghsaId: fresh },
      { state: 'Triage', comments: [], timeline: [] },
      { storage, at: clockAt - 4 * MINUTE }
    );
    await cache.putAdvisory(
      { owner, repo, ghsaId: stale },
      { state: 'Triage', comments: [], timeline: [] },
      { storage, at: clockAt - 6 * MINUTE }
    );
    const fetch = fakeFetch({
      [`${base}?state=draft`]: listHtml({ owner, repo, state: 'draft', ids: [] }),
      [`${base}/${stale}`]: detailHtml(stale, 'Triage'),
    });

    const summary = await table.refresh(doc, {
      storage,
      fetch: fetch.send,
      wait: advance,
      href: `${base}?state=triage`,
    });

    assert.deepStrictEqual(fetch.urls, [`${base}?state=draft`, `${base}/${stale}`]);
    assert.ok(summary !== null && summary.read.skipped === 1, 'the fresh advisory was not skipped');
  } finally {
    clockAt = started;
  }
});

test('one repository has one refresh queue', () => {
  const first = table.queueFor({ owner: 'crawl-one', repo: 'repo' });
  const again = table.queueFor({ owner: 'crawl-one', repo: 'repo' });
  assert.ok(first === again, 'a second queue was made for one repository');
  // GitHub treats an owner and a repository name case-insensitively, and two
  // queues would each hold the rate limit privately.
  const spelled = table.queueFor({ owner: 'Crawl-One', repo: 'Repo' });
  assert.ok(spelled === first, 'another spelling of one repository made a second queue');
  const other = table.queueFor({ owner: 'crawl-two', repo: 'repo' });
  assert.ok(other !== first, 'two repositories shared one queue');
});

/**
 * @param {string} ghsaId
 * @param {Partial<import('../src/list/table.js').TableRow>} [changes]
 * @returns {import('../src/list/table.js').TableRow} a row carrying the list
 *   markup's defaults, with the values one case turns on.
 */
function sortRow(ghsaId, changes = {}) {
  return { ...table.unreadRow(listRow(ghsaId, '2026-08-01T00:00:00Z'), AT), ...changes };
}

/**
 * @param {readonly import('../src/list/table.js').TableRow[]} rows
 * @param {string} sort
 * @param {Record<string, string>} [filters]
 * @returns {string} the identifiers the view shows, in the order it shows them.
 */
function viewOrder(rows, sort, filters = {}) {
  return table
    .applyView(rows, { sort, filters })
    .map((row) => row.ghsaId ?? '')
    .join(' ');
}

/**
 * One sort key, and three rows it ranks C first, A second, B third.
 *
 * Every case is handed to the sort as A, B, C, and every case wants C, A, B. So
 * neither the order the rows arrive in nor the order of their identifiers can
 * stand in for the key under test: a comparator that ignored the key would
 * answer A B C through the identifier tie-break and fail.
 *
 * @type {readonly { sort: string, what: string, rows: import('../src/list/table.js').TableRow[] }[]}
 */
const SORT_CASES = [
  {
    sort: 'waiting',
    what: 'longest waiting first, and a wait that went unread last',
    rows: [
      sortRow('A', { waitingSince: '2026-08-20T00:00:00Z' }),
      sortRow('B', { waitingSince: null }),
      sortRow('C', { waitingSince: '2026-06-01T00:00:00Z' }),
    ],
  },
  {
    sort: 'severity',
    what: 'every confirmed severity above every unconfirmed one',
    rows: [
      sortRow('A', { severity: 'critical', severityLabel: 'Critical' }),
      sortRow('B', {}),
      sortRow('C', { severity: 'low', severityLabel: 'Low', severityConfirmed: true }),
    ],
  },
  {
    sort: 'owner',
    what: 'by owner, and an unowned advisory last',
    rows: [
      sortRow('A', { read: true, owners: ['zoe'] }),
      sortRow('B', { read: true, owners: [] }),
      sortRow('C', { read: true, owners: ['ada'] }),
    ],
  },
  {
    sort: 'reporter',
    what: 'by reporter, and one nobody read last',
    rows: [
      sortRow('A', { reporter: 'zoe' }),
      sortRow('B', { reporter: null }),
      sortRow('C', { reporter: 'ada' }),
    ],
  },
  {
    sort: 'state',
    what: 'by state, and one GitHub did not name last',
    rows: [
      sortRow('A', { state: 'Triage' }),
      sortRow('B', { state: null }),
      sortRow('C', { state: 'Draft' }),
    ],
  },
  {
    sort: 'patch',
    what: 'by patch state, and an advisory with no patch last',
    rows: [
      sortRow('A', { read: true, patch: 'Patch in review' }),
      sortRow('B', { read: true, patch: null }),
      sortRow('C', { read: true, patch: 'Patch closed' }),
    ],
  },
  {
    sort: 'backports',
    what: 'the most branches still outstanding first',
    rows: [
      sortRow('A', { read: true, backportTargets: 2, backportsDone: 1 }),
      sortRow('B', { read: true, backportTargets: 0, backportsDone: 0 }),
      sortRow('C', { read: true, backportTargets: 3, backportsDone: 0 }),
    ],
  },
  {
    sort: 'cve',
    what: 'the furthest along CVE first',
    rows: [
      sortRow('A', { read: true, cveState: 'requested', cve: 'CVE requested' }),
      sortRow('B', { read: true, cveState: 'none' }),
      sortRow('C', { read: true, cveState: 'assigned', cve: 'CVE-2026-0001' }),
    ],
  },
  {
    sort: 'embargo',
    what: 'an overdue embargo above one still running, above none',
    rows: [
      sortRow('A', { read: true, embargo: true, embargoLift: '2026-09-30' }),
      sortRow('B', { read: true }),
      sortRow('C', { read: true, embargo: true, embargoLift: '2026-01-01', embargoOverdue: true }),
    ],
  },
  {
    sort: 'confirmed',
    what: 'the most tracks a maintainer confirmed first',
    rows: [
      sortRow('A', { read: true, severityConfirmed: true }),
      sortRow('B', { read: true }),
      sortRow('C', { read: true, textConfirmed: true, severityConfirmed: true }),
    ],
  },
  {
    sort: 'opened',
    what: 'the oldest report first',
    rows: [
      sortRow('A', { openedAt: '2026-01-01T00:00:00Z' }),
      sortRow('B', { openedAt: null }),
      sortRow('C', { openedAt: '2020-01-01T00:00:00Z' }),
    ],
  },
  {
    sort: 'observed',
    what: 'the stalest read first',
    rows: [
      sortRow('A', { observedAt: AT - 60 * MINUTE }),
      sortRow('B', { observedAt: AT }),
      sortRow('C', { observedAt: AT - 180 * MINUTE }),
    ],
  },
  {
    sort: 'title',
    what: 'by title, and one GitHub did not name last',
    rows: [
      sortRow('A', { title: 'Zoe' }),
      sortRow('B', { title: null }),
      sortRow('C', { title: 'Ada' }),
    ],
  },
];

test('every sort key orders by the value it names', () => {
  const covered = SORT_CASES.map((each) => each.sort).sort();
  const facets = table.FACETS.map((facet) => facet.key).sort();
  assert.deepStrictEqual(covered, facets, 'a facet with no case');

  for (const each of SORT_CASES) {
    const got = viewOrder(each.rows, each.sort);
    assert.ok(got === 'C A B', `${each.sort}, ${each.what}: ${got}`);
  }
});

test('returning to the default order undoes a sort and a filter', () => {
  const rows = [
    sortRow('A', { read: true, triage: 'awaiting reporter', waitingSince: '2026-08-20T00:00:00Z' }),
    sortRow('B', { read: true, neverReviewed: true, waitingSince: '2026-08-24T00:00:00Z' }),
    sortRow('C', { read: true, triage: 'evaluating', waitingSince: '2026-08-22T00:00:00Z' }),
  ];
  const picked = viewOrder(rows, 'title', { waiting: 'Blocked on us' });
  assert.ok(picked === 'C', `a sort and a filter together: ${picked}`);
  const back = table.applyView(rows, table.defaultViewState()).map((row) => row.ghsaId).join(' ');
  assert.ok(back === 'B C A', `the default order after picking another: ${back}`);
});

test('a filter on a value some rows do not have keeps only those that do', () => {
  const rows = [
    sortRow('A', { read: true, severity: 'high', severityLabel: 'High' }),
    sortRow('B', { read: true }),
    sortRow('C', { read: true, severity: 'low', severityLabel: 'Low' }),
  ];
  const high = viewOrder(rows, 'title', { severity: 'High' });
  assert.ok(high === 'A', `the rows carrying a high severity: ${high}`);
  const none = viewOrder(rows, 'title', { severity: table.NO_VALUE });
  assert.ok(none === 'B', `the rows a read left with no severity: ${none}`);
});

/**
 * @param {string} key
 * @returns {import('../src/list/table.js').Facet}
 */
function facet(key) {
  const found = table.facetFor(key);
  if (found === null) throw new Error(`no facet named ${key}`);
  return found;
}

test('a filter offers the values the rows hold, in the order they belong in', () => {
  // Alphabetically these read Critical, High, Low, Moderate, so an option list
  // in rank order is one the alphabet cannot produce.
  const rows = [
    sortRow('A', { read: true, severity: 'low', severityLabel: 'Low' }),
    sortRow('B', { read: true, severity: 'critical', severityLabel: 'Critical' }),
    sortRow('C', { read: true, severity: 'high', severityLabel: 'High' }),
    sortRow('D', { read: true, severity: 'moderate', severityLabel: 'Moderate' }),
  ];
  const offered = table.filterOptions(rows, facet('severity'), '').join(' ');
  assert.ok(
    offered === 'Critical High Moderate Low',
    `severity is offered by rank, not alphabetically: ${offered}`
  );

  const withNone = table.filterOptions([...rows, sortRow('E', { read: true })], facet('severity'), '');
  assert.ok(
    withNone.join(' ') === `Critical High Moderate Low ${table.NO_VALUE}`,
    `a read row holding no severity: ${withNone.join(' ')}`
  );

  // A row nobody has read holds nothing, and that is not a value to offer.
  const unread = table.filterOptions([...rows, sortRow('E')], facet('severity'), '');
  assert.ok(unread.join(' ') === 'Critical High Moderate Low', `an unread row: ${unread.join(' ')}`);

  // A login this reader has no rank for falls back to the alphabet.
  const logins = [
    sortRow('A', { read: true, owners: ['zoe'] }),
    sortRow('B', { read: true, owners: ['ada'] }),
  ];
  const byName = table.filterOptions(logins, facet('owner'), '').join(' ');
  assert.ok(byName === 'ada zoe', `owners are offered alphabetically: ${byName}`);
});

test('a value a filter is holding to stays on offer after the last row carrying it leaves', () => {
  const rows = [sortRow('A', { read: true, owners: ['ada'] })];
  const offered = table.filterOptions(rows, facet('owner'), 'zoe').join(' ');
  assert.ok(offered === 'ada zoe', `the filtered value is still offered: ${offered}`);
});

/**
 * Rows covering every branch of every facet's comparator. The identifier
 * descends as the grid is built, so the order the rows arrive in and the order
 * of their identifiers contradict each other.
 *
 * @returns {import('../src/list/table.js').TableRow[]}
 */
function viewGrid() {
  const reads = [false, true];
  const scores = [
    { severity: null, severityLabel: null, severityConfirmed: false },
    { severity: 'critical', severityLabel: 'Critical', severityConfirmed: false },
    { severity: 'low', severityLabel: 'Low', severityConfirmed: true },
  ];
  const owners = [[], ['ada'], ['zoe', 'ada']];
  const waits = [null, '2026-01-01T00:00:00Z', '2026-08-01T00:00:00Z', '2020-06-01T00:00:00Z'];
  const states = ['Triage', 'Draft', null];
  const reporters = ['prakleumas', 'zoe', null];
  const patches = ['Patch in review', 'Patch merged', 'Patch closed', null];
  const backports = [
    { backportTargets: 0, backportsDone: 0 },
    { backportTargets: 2, backportsDone: 0 },
    { backportTargets: 2, backportsDone: 2 },
  ];
  /** @type {(import('../src/list/table.js').TableRow['cveState'])[]} */
  const cves = ['assigned', 'requested', 'not applicable', 'none', null];
  const embargoes = [
    { embargo: false, embargoOverdue: false },
    { embargo: true, embargoOverdue: false },
    { embargo: true, embargoOverdue: true },
  ];
  const tiers = [
    { neverReviewed: true, newActivity: false, triage: null },
    { neverReviewed: false, newActivity: true, triage: null },
    { neverReviewed: false, newActivity: false, triage: 'evaluating' },
    { neverReviewed: false, newActivity: false, triage: 'awaiting reporter' },
  ];
  const titles = ['Ada', 'Zoe', null];
  const opened = ['2020-01-01T00:00:00Z', '2026-01-01T00:00:00Z', null];

  const size = 60;
  /** @type {import('../src/list/table.js').TableRow[]} */
  const rows = [];
  for (let i = 0; i < size; i += 1) {
    const at = /** @type {<T>(list: readonly T[]) => T} */ (
      (list) => /** @type {any} */ (list[i % list.length])
    );
    rows.push(
      sortRow(`GHSA-${String(size - i).padStart(4, '0')}`, {
        read: at(reads),
        owners: at(owners).slice(),
        waitingSince: at(waits),
        state: at(states),
        reporter: at(reporters),
        patch: at(patches),
        cveState: at(cves),
        title: at(titles),
        openedAt: at(opened),
        observedAt: AT - (i % 7) * MINUTE,
        textConfirmed: i % 2 === 0,
        ...at(scores),
        ...at(backports),
        ...at(embargoes),
        ...at(tiers),
      })
    );
  }
  return rows;
}

/**
 * @param {(a: import('../src/list/table.js').TableRow, b: import('../src/list/table.js').TableRow) => number} compare
 * @param {readonly import('../src/list/table.js').TableRow[]} rows
 * @param {string} what
 */
function isTotalOrder(compare, rows, what) {
  for (const a of rows) {
    assert.ok(compare(a, a) === 0, `${what}: ${a.ghsaId} against itself`);
    for (const b of rows) {
      const forward = Math.sign(compare(a, b));
      const back = Math.sign(compare(b, a));
      assert.ok(forward === -back, `${what}: ${a.ghsaId} and ${b.ghsaId} disagree on which comes first`);
      if (a !== b) assert.ok(forward !== 0, `${what}: ${a.ghsaId} and ${b.ghsaId} are distinct but tie`);
    }
  }
  for (const a of rows) {
    for (const b of rows) {
      if (compare(a, b) > 0) continue;
      for (const c of rows) {
        if (compare(b, c) > 0) continue;
        assert.ok(
          compare(a, c) <= 0,
          `${what}: ${a.ghsaId} before ${b.ghsaId} before ${c.ghsaId} does not carry through`
        );
      }
    }
  }
}

test('every sort is a total order over a grid of the values it branches on', () => {
  const rows = viewGrid();
  assert.ok(rows.length === 60, `grid size: ${rows.length}`);
  for (const each of table.FACETS) {
    const compare = table.sortFor(each.key);
    if (compare === null) throw new Error(`${each.key} runs no comparator`);
    isTotalOrder(compare, rows, each.key);
  }
  assert.ok(table.sortFor(table.DEFAULT_SORT) === null, 'the default order is a sort key among others');
});

test('a sort does not depend on the order the rows arrived in', () => {
  const rows = viewGrid();
  let seed = 12345;
  /** @returns {import('../src/list/table.js').TableRow[]} */
  const shuffle = () => {
    const shuffled = rows.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      const swap = /** @type {import('../src/list/table.js').TableRow} */ (shuffled[i]);
      shuffled[i] = /** @type {import('../src/list/table.js').TableRow} */ (shuffled[j]);
      shuffled[j] = swap;
    }
    return shuffled;
  };

  for (const each of [...table.FACETS.map((facet) => facet.key), table.DEFAULT_SORT]) {
    const wanted = viewOrder(rows, each);
    for (let round = 0; round < 5; round += 1) {
      const got = viewOrder(shuffle(), each);
      assert.ok(got === wanted, `${each}, shuffle ${round}, differs from the order of the grid`);
    }
    assert.ok(viewOrder(table.applyView(rows, { sort: each, filters: {} }), each) === wanted,
      `${each}: a second pass moved something`);
  }
});

test('a row whose identifier went unread sorts last under every sort', () => {
  // The identifier is the last tie-break on both paths: the default order runs
  // `order.compare`, and every other sort ends in this file's own tie-break.
  // The two read a null identifier the same way, so the row nobody can open is
  // at the bottom either way.
  const unread = sortRow('GHSA-aaaa-aaaa-aaaa', {
    ghsaId: null,
    waitingSince: '2026-08-01T00:00:00Z',
  });
  const known = sortRow('GHSA-aaaa-aaaa-aaaa', { waitingSince: '2026-08-01T00:00:00Z' });
  const waiting = table.applyView([unread, known], { sort: 'waiting', filters: {} });
  assert.ok(waiting[0] === known, 'the waiting sort put the unread identifier first');
  const byDefault = table.applyView([unread, known], table.defaultViewState());
  assert.ok(byDefault[0] === known, 'the default order put the unread identifier first');
});

test('sorting and filtering leave the rows the table holds alone', () => {
  const rows = [sortRow('B', { read: true, title: 'Zoe' }), sortRow('A', { read: true, title: 'Ada' })];
  table.applyView(rows, { sort: 'title', filters: { owner: table.NO_VALUE } });
  assert.ok(rows[0]?.ghsaId === 'B', 'the array the table holds was reordered');
  assert.ok(rows.length === 2, 'the array the table holds lost a row');
});

/**
 * @param {import('../src/list/table.js').TableRow} row
 * @returns {string} what each facet reads for one row, as one line.
 */
function facetLine(row) {
  return table.FACETS.filter((each) => each.filter === true)
    .map((each) => `${each.key}=${each.valuesOf(row).join('+')}`)
    .join(' ');
}

test('every filter reads the fixture the cache holds', async () => {
  const parsed = parseList.parseList(listPage('list-page-triage.html'));
  if (parsed === null) throw new Error('the fixture is not a list page');
  const source = parsed.rows[0];
  if (source === undefined) throw new Error('the fixture carries no row');

  const read = await table.viewRow(source, entryOf(TRIAGE_RECORD, 'triage'), AT);
  assert.ok(
    facetLine(read) ===
      'waiting=Blocked on the reporter severity=High owner=samuelkarp reporter=prakleumas' +
        ' state=Triage patch=In review backports=Outstanding cve= embargo=Set confirmed=',
    `the facets of the cached triage read: ${facetLine(read)}`
  );

  // The same advisory before anything has been read holds what GitHub's row
  // said and nothing a read supplies, so a filter over those facets keeps it.
  const unread = table.unreadRow(source, AT);
  assert.ok(
    facetLine(unread) ===
      'waiting= severity=High owner= reporter=prakleumas state=Triage patch= backports=' +
        ' cve= embargo= confirmed=',
    `the facets before a read: ${facetLine(unread)}`
  );
  for (const each of table.FACETS) {
    if (each.filter !== true) continue;
    const held = each.valuesOf(read);
    const wanted = held[0] ?? table.NO_VALUE;
    assert.ok(
      table.matchesFilter(each, unread, wanted),
      `${each.key}: a filter on ${wanted} hides the row before it is read`
    );
  }
});

/**
 * @param {Element} node
 * @returns {void} tells the control's handler that its value moved.
 */
function changed(node) {
  const view = node.ownerDocument?.defaultView;
  if (view === null || view === undefined) throw new Error('the document has no view');
  node.dispatchEvent(new view.Event('change', { bubbles: true }));
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
  let found = false;
  for (const option of select.querySelectorAll('option')) {
    const held = option.getAttribute('value') ?? '';
    if (held === value) {
      option.setAttribute('selected', '');
      found = true;
    } else {
      option.removeAttribute('selected');
    }
  }
  if (!found) throw new Error(`the control offers no ${value === '' ? 'blank option' : value}`);
  changed(select);
}

/**
 * @param {Document} doc
 * @param {string} facet
 * @returns {Element} the control holding the table to one value of that facet.
 */
function filterIn(doc, facet) {
  for (const control of doc.querySelectorAll(`#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}]`)) {
    if (control.getAttribute(table.FACET_ATTRIBUTE) === facet) return control;
  }
  throw new Error(`the table offers no ${facet} filter`);
}

/**
 * @param {Element} select
 * @returns {string} what the control offers, as one line.
 */
function optionsOf(select) {
  return Array.from(select.querySelectorAll('option'))
    .map((option) => option.textContent ?? '')
    .join(' | ');
}

/**
 * @param {Document} doc
 * @returns {string} the identifiers the table is showing, in the order it shows
 *   them.
 */
function shownIds(doc) {
  return tableRows(doc)
    .map((row) => row.getAttribute('data-bghsa-ghsa') ?? '')
    .join(' ');
}

/**
 * A table drawn over rows a test made up, placed on a real list page so it has
 * the anchor the page offers.
 *
 * @param {readonly import('../src/list/table.js').TableRow[]} rows
 * @returns {{ doc: Document, root: Element }}
 */
function tableOver(rows) {
  const doc = listPage('list-page-triage.html');
  cache.setStorage(fakeStorage());
  table.setViewState(doc, table.defaultViewState());
  /** @type {Map<string, import('../src/common/parse-list.js').ListRow>} */
  const sources = new Map();
  for (const row of rows) {
    if (row.ghsaId !== null) sources.set(row.ghsaId, listRow(row.ghsaId, '2026-08-01T00:00:00Z'));
  }
  const root = table.injectTable(doc, { rows: rows.slice(), at: AT, sources });
  if (root === null) throw new Error('the page offered no anchor');
  return { doc, root };
}

test('the controls offer every value the table holds', async () => {
  const doc = listPage('list-page-triage.html');
  table.setViewState(doc, table.defaultViewState());
  await render(doc, { [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(TRIAGE_RECORD, 'triage') });

  const sort = one(doc, `#${table.ROOT_ID} .bghsa-list-sort`);
  const offered = optionsOf(sort);
  const wanted = [table.DEFAULT_SORT_LABEL, ...table.FACETS.map(table.sortLabelOf)].join(' | ');
  assert.ok(offered === wanted, `the sort offers: ${offered}`);
  assert.ok(
    offered ===
      'Default order | Longest waiting | Highest severity | Owner | Reporter | State |' +
        ' Patch | Backports | CVE | Embargo | Confirmed | Oldest opened | Stalest observed | Title',
    `the sort labels: ${offered}`
  );

  const filters = Array.from(doc.querySelectorAll(`#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}]`))
    .map((control) => control.getAttribute(table.FACET_ATTRIBUTE) ?? '')
    .join(' ');
  assert.ok(
    filters === 'waiting severity owner reporter state patch backports cve embargo confirmed',
    `the filters offered: ${filters}`
  );

  // Every filter comes up holding the table to nothing, reading the facet it
  // acts on, and offering what the rows of the table hold.
  assert.ok(
    optionsOf(filterIn(doc, 'owner')) === 'Owner | samuelkarp',
    `the owner filter offers: ${optionsOf(filterIn(doc, 'owner'))}`
  );
  assert.ok(
    optionsOf(filterIn(doc, 'waiting')) === 'Waiting | Blocked on the reporter',
    `the waiting filter offers: ${optionsOf(filterIn(doc, 'waiting'))}`
  );

  const reset = one(doc, `#${table.ROOT_ID} .bghsa-list-reset`);
  assert.ok((reset.textContent ?? '') === table.RESET_LABEL, `the reset reads: ${reset.textContent}`);
});

test('a filter that keeps nothing says so', () => {
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', {
      read: true,
      owners: ['ada'],
      severity: 'high',
      severityLabel: 'High',
    }),
    sortRow('GHSA-bbbb-bbbb-bbbb', {
      read: true,
      owners: ['zoe'],
      severity: 'low',
      severityLabel: 'Low',
    }),
  ]);
  choose(filterIn(doc, 'owner'), 'ada');
  choose(filterIn(doc, 'severity'), 'Low');
  assert.ok(shownIds(doc) === '', `rows under a filter nothing matches: ${shownIds(doc)}`);
  const empty = textOf(doc, `#${table.ROOT_ID} .bghsa-list-empty`);
  assert.ok(empty === table.EMPTY_TEXT, `what stands in for the rows: ${empty}`);
  assert.ok(empty === 'No advisory matches the filter', `the wording: ${empty}`);
  const count = textOf(doc, `#${table.ROOT_ID} .bghsa-list-count`);
  assert.ok(count === '0 of 2 advisories', `the count: ${count}`);
});

test('a table holding no advisory at all says nothing about a filter', () => {
  const { doc } = tableOver([]);
  assert.ok(doc.querySelector(`#${table.ROOT_ID} .bghsa-list-empty`) === null, 'a filter was blamed');
  assert.ok(textOf(doc, `#${table.ROOT_ID} .bghsa-list-count`) === '0 advisories', 'the count');
});

test('the reset goes back to the default order and drops every filter', () => {
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', { read: true, owners: ['ada'], title: 'Zoe' }),
    sortRow('GHSA-bbbb-bbbb-bbbb', { read: true, owners: ['zoe'], title: 'Ada' }),
  ]);
  choose(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'title');
  choose(filterIn(doc, 'owner'), 'ada');
  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa', `sorted and filtered: ${shownIds(doc)}`);

  /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-list-reset`))
  ).click();

  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa GHSA-bbbb-bbbb-bbbb', `back to the default: ${shownIds(doc)}`);
  // The controls read the view that is showing, so the way back is not hidden
  // behind controls still naming the view that was.
  const sort = one(doc, `#${table.ROOT_ID} .bghsa-list-sort`);
  assert.ok(
    (sort.querySelector('option[selected]')?.textContent ?? '') === table.DEFAULT_SORT_LABEL,
    'the sort control still names the sort that was'
  );
  assert.ok(
    (filterIn(doc, 'owner').querySelector('option[selected]')?.getAttribute('value') ?? 'x') === '',
    'the owner filter still names the owner it was holding'
  );
});

test('a read landing leaves the sort and the filter a maintainer picked alone', async () => {
  const ghsaId = 'GHSA-bbbb-bbbb-bbbb';
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', { read: true, owners: ['ada'], title: 'Zoe' }),
    sortRow(ghsaId, { title: 'Ada' }),
  ]);
  choose(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'title');
  choose(filterIn(doc, 'owner'), 'ada');
  // A row nobody has read is not hidden by a filter over a value a read
  // supplies, so both are showing.
  assert.ok(shownIds(doc) === `${ghsaId} GHSA-aaaa-aaaa-aaaa`, `by title under the owner filter: ${shownIds(doc)}`);

  const detail = parseDetail.parseDetail(
    /** @type {Document} */ (/** @type {unknown} */ (parseHTML(detailHtml(ghsaId, 'Triage')).document))
  );
  const applied = await table.applyEntry(doc, ghsaId, {
    record: detail,
    observedAt: AT - 30 * MINUTE,
    state: 'triage',
  });
  assert.ok(applied, 'no row was replaced');

  // The read turns the row into one the owner filter does not match and one the
  // default order would put in another tier. It keeps its place and it keeps
  // showing: the view a maintainer is reading is not rearranged under them.
  assert.ok(shownIds(doc) === `${ghsaId} GHSA-aaaa-aaaa-aaaa`, `after the read: ${shownIds(doc)}`);
  const row = /** @type {Element} */ (tableRows(doc)[0]);
  assert.ok(
    chipLine(row) === 'Never reviewed[danger] | High, unconfirmed',
    `the row took the read in: ${chipLine(row)}`
  );
  // The read turned up a severity no row carried, and the control offers it.
  assert.ok(
    optionsOf(filterIn(doc, 'severity')) === 'Severity | High | None',
    `the severity filter after the read: ${optionsOf(filterIn(doc, 'severity'))}`
  );

  // The render that follows the pass is what settles it, under the same view.
  table.refreshBody(doc);
  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa', `once the table settles: ${shownIds(doc)}`);
});

test('a read for a row a filter is holding out of view still reaches the table', async () => {
  const ghsaId = 'GHSA-bbbb-bbbb-bbbb';
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', { read: true, owners: ['ada'] }),
    sortRow(ghsaId, { read: true, owners: ['zoe'] }),
  ]);
  choose(filterIn(doc, 'owner'), 'ada');
  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa', `under the owner filter: ${shownIds(doc)}`);

  const detail = parseDetail.parseDetail(
    /** @type {Document} */ (/** @type {unknown} */ (parseHTML(detailHtml(ghsaId, 'Triage')).document))
  );
  const applied = await table.applyEntry(doc, ghsaId, {
    record: detail,
    observedAt: AT - 30 * MINUTE,
    state: 'triage',
  });
  assert.ok(!applied, 'a row a filter is holding out of view was drawn');
  // The table took the read in even so, which the filter shows once it is
  // holding to what the read turned up.
  choose(filterIn(doc, 'severity'), 'High');
  choose(filterIn(doc, 'owner'), '');
  assert.ok(shownIds(doc) === ghsaId, `the row the read filled in: ${shownIds(doc)}`);
});

test('a re-render keeps the view a maintainer picked', async () => {
  const low = 'GHSA-aaaa-aaaa-aaaa';
  const high = 'GHSA-bbbb-bbbb-bbbb';
  const doc = pageOf(listHtml({ ...REF, state: 'triage', ids: [low, high] }));
  table.setViewState(doc, table.defaultViewState());
  /** @type {Record<string, unknown>} */
  const held = {
    [keyFor(low)]: entryOf(storedDetail(low, 'Triage', 'Low'), 'triage'),
    [keyFor(high)]: entryOf(storedDetail(high, 'Triage', 'High'), 'triage'),
  };
  await render(doc, held);
  assert.ok(shownIds(doc) === `${low} ${high}`, `the default order: ${shownIds(doc)}`);

  choose(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'severity');
  assert.ok(shownIds(doc) === `${high} ${low}`, `the highest severity first: ${shownIds(doc)}`);
  choose(filterIn(doc, 'severity'), 'Low');
  assert.ok(shownIds(doc) === low, `held to the low severity: ${shownIds(doc)}`);

  // GitHub replacing the subtree, and the pass that follows a read, both draw
  // the table again. The view a maintainer picked survives that.
  await render(doc, held);
  const sort = one(doc, `#${table.ROOT_ID} .bghsa-list-sort`);
  assert.ok(
    (sort.querySelector('option[selected]')?.getAttribute('value') ?? '') === 'severity',
    'the sort was lost when the table was drawn again'
  );
  assert.ok(
    (filterIn(doc, 'severity').querySelector('option[selected]')?.getAttribute('value') ?? '') === 'Low',
    'the filter was lost when the table was drawn again'
  );
  assert.ok(shownIds(doc) === low, `the rows after the table was drawn again: ${shownIds(doc)}`);

  choose(filterIn(doc, 'severity'), 'High');
  assert.ok(shownIds(doc) === high, `the row the filter keeps: ${shownIds(doc)}`);
});

test("the controls go out of view with the table, and the toggle stays", async () => {
  const doc = listPage('list-page-triage.html');
  table.setViewState(doc, table.defaultViewState());
  await render(doc);
  const controls = one(doc, `#${table.ROOT_ID} .bghsa-list-controls`);
  assert.ok(!controls.classList.contains(table.HIDDEN_CLASS), 'the controls came up hidden');

  toggleIn(doc).click();
  assert.ok(controls.classList.contains(table.HIDDEN_CLASS), "the controls stayed on GitHub's view");
  assert.ok(
    !one(doc, `#${table.ROOT_ID} .bghsa-list-toggle`).classList.contains(table.HIDDEN_CLASS),
    'the toggle went out of view with them'
  );

  toggleIn(doc).click();
  assert.ok(!controls.classList.contains(table.HIDDEN_CLASS), 'the controls did not come back');
});
