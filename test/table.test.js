'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parseList = require('../src/common/parse-list.js');
const parseDetail = require('../src/common/parse-detail.js');
const cache = require('../src/common/cache.js');
const table = require('../src/list/table.js');

const { fakeStorage } = require('../test-support/storage.js');

/** The moment every render in this file reads the page at. */
const AT = Date.parse('2026-08-26T12:00:00Z');

/** The moment the cached advisory reads in this file were taken at. */
const OBSERVED = Date.parse('2026-08-26T10:00:00Z');

cache.setClock(() => AT);

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
