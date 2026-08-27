'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML, DOMParser } = require('linkedom');

const parseList = require('../src/common/parse-list.js');
const parseDetail = require('../src/common/parse-detail.js');
const cache = require('../src/common/cache.js');
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
 * @returns {string}
 */
function detailHtml(ghsaId, state) {
  return (
    '<!doctype html><html><body><div class="gh-header-meta">' +
    `<span class="State">${state}</span>` +
    '<span class="Label Label--large" title="Severity: High">High</span>' +
    `<span class="user-select-contain">${ghsaId}</span>` +
    '</div></body></html>'
  );
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
