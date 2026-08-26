'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const derive = require('../src/common/derive.js');
const panel = require('../src/detail/panel.js');

/**
 * @param {string} name
 * @returns {Document}
 */
function parseFixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * Reads the advisory out of a fixture and drops the document. A parsed record
 * is plain data, so one read supplies every rendering assertion below.
 *
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function readRecord(name) {
  const parsed = parse.parseDetail(parseFixture(name));
  if (parsed === null) throw new Error(`${name} is not an advisory detail page`);
  return parsed;
}

/** The one parse of each large fixture in this file. */
const triageDoc = parseFixture('triage-thread.html');
const triage = /** @type {import('../src/common/parse-detail.js').ParsedDetail} */ (
  parse.parseDetail(triageDoc)
);
const draft = readRecord('draft.html');
const published = readRecord('published-containerd.html');

/** The document panels are built into when the test only reads the panel. */
const blank = /** @type {Document} */ (
  /** @type {unknown} */ (parseHTML('<!doctype html><html><head></head><body></body></html>').document)
);

/**
 * The elements the panel's placement is keyed on, nested as GitHub nests them:
 * the description Box inside the live region that GitHub replaces on its own,
 * inside the main column.
 */
const PAGE = [
  '<!doctype html><html><head></head><body>',
  '<div class="clearfix new-discussion-timeline container-xl">',
  '<div class="d-flex flex-column flex-md-row">',
  '<div class="col-12 col-md-9">',
  '<div class="js-quote-selection-container">',
  '<div class="js-socket-channel js-updatable-content"',
  ' data-url="/o/r/security/advisories/GHSA-0000-0000-0000/show_partial?partial=repository_advisory%2Fbody">',
  '<div class="Box">',
  '<div class="js-repository-advisory-details">',
  '<div class="Box-header timeline-comment-header">description</div>',
  '</div></div></div></div></div></div></body></html>',
].join('');

/**
 * @returns {Document} a document carrying the anchor elements and nothing else.
 */
function page() {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(PAGE).document));
}

/**
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @returns {Element} the panel this advisory renders to.
 */
function build(advisory) {
  return panel.buildPanel(blank, advisory, derive.derive(advisory));
}

/**
 * @param {Document} doc
 * @param {import('../src/common/parse-detail.js').ParsedDetail} [advisory]
 * @returns {Element} the panel placed in `doc`.
 */
function place(doc, advisory = triage) {
  const injected = panel.injectPanel(doc, advisory, derive.derive(advisory));
  if (injected === null) throw new Error('the document offered no anchor');
  return injected;
}

/**
 * @param {Document} doc
 * @returns {void} takes the panel and its stylesheet back out of `doc`.
 */
function reset(doc) {
  for (const node of doc.querySelectorAll('#bghsa-detail-panel, #bghsa-style')) node.remove();
}

/**
 * @param {Element | null} node
 * @returns {string}
 */
function text(node) {
  return String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {Element} root
 * @param {string} selector
 * @returns {string[]}
 */
function texts(root, selector) {
  return Array.from(root.querySelectorAll(selector)).map((node) => text(node));
}

/**
 * @param {Element} root
 * @param {string} label
 * @returns {string} the text of the panel row carrying `label`.
 */
function rowText(root, label) {
  for (const row of root.querySelectorAll('.Box-row')) {
    if (text(row.querySelector('.bghsa-label')) === label) {
      return text(row.querySelector('.flex-auto'));
    }
  }
  throw new Error(`no panel row labelled ${label}`);
}

/**
 * @param {Element} root
 * @param {string} label the chip's own text.
 * @returns {string} the class attribute of the chip reading `label`.
 */
function chipClass(root, label) {
  for (const node of root.querySelectorAll('.Box-header .Label')) {
    if (text(node) === label) return String(node.getAttribute('class') ?? '');
  }
  throw new Error(`no chip reading ${label}`);
}

test('the chip row reads state, severity, and CVE', () => {
  assert.deepStrictEqual(texts(build(triage), '.Box-header .Label'), [
    'State: Triage',
    'Severity: High',
    'CVE: none',
  ]);
});

test('a signal that is not firing carries no chip', () => {
  const state = derive.derive(triage);
  assert.strictEqual(state.neverReviewed, false);
  assert.strictEqual(state.newActivity, false);
  const chips = texts(build(triage), '.Box-header .Label');
  assert.deepStrictEqual(
    chips.filter((label) => label === 'Never reviewed' || label === 'New activity'),
    []
  );
});

test('the panel reports whether the description is the original text', () => {
  assert.strictEqual(rowText(build(triage), 'Description'), "The reporter's original text.");
  assert.strictEqual(rowText(build(draft), 'Description'), 'Edited since it was reported.');
});

test('the panel sits in the main column, above the description Box, outside both live regions', () => {
  reset(triageDoc);
  const injected = panel.render(triageDoc);
  assert.ok(injected !== null, 'render placed no panel');
  const placed = /** @type {Element} */ (injected);

  const column = triageDoc.querySelector('div.col-12.col-md-9');
  assert.ok(column !== null, 'the page has no main column');
  assert.ok(placed.closest('div.col-12.col-md-9') === column, 'the panel is not in the main column');
  assert.ok(placed.closest('div.js-socket-channel') === null, 'the panel is inside a live region');

  const next = placed.nextElementSibling;
  assert.ok(next !== null, 'the panel has no following sibling');
  const region = /** @type {Element} */ (next);
  assert.match(
    region.getAttribute('data-url') ?? '',
    /show_partial\?partial=repository_advisory%2Fbody$/
  );
  const description = triageDoc.querySelector(
    'div.js-repository-advisory-details > div.Box-header.timeline-comment-header'
  );
  assert.ok(description !== null, 'the page has no description Box header');
  assert.strictEqual(region.contains(description), true);
});

test('injecting twice leaves one panel', () => {
  const doc = page();
  place(doc);
  place(doc);
  place(doc);
  assert.strictEqual(doc.querySelectorAll('#bghsa-detail-panel').length, 1);
  assert.strictEqual(doc.querySelectorAll('#bghsa-style').length, 1);
});

test('an advisory whose every displayed value reads carries no banner', () => {
  assert.deepStrictEqual(texts(build(triage), '.bghsa-banner'), []);
});

test('a severity that cannot be read is shown as missing and raises the banner', () => {
  const built = build(draft);
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), [
    'State: Draft',
    'Severity: missing',
    'CVE: none',
  ]);
  assert.strictEqual(
    chipClass(built, 'Severity: missing'),
    'Label Label--secondary bghsa-tone-attention bghsa-missing'
  );
  assert.deepStrictEqual(texts(built, '.bghsa-banner'), [
    'Incomplete: this extension could not read severity.',
  ]);
});

test('a description whose provenance cannot be read is shown as missing', () => {
  const built = build({ ...draft, descriptionOriginal: null });
  assert.strictEqual(rowText(built, 'Description'), 'Provenance missing.');
  assert.deepStrictEqual(texts(built, '.Box-row .bghsa-missing'), ['missing']);
  assert.deepStrictEqual(texts(built, '.bghsa-banner'), [
    'Incomplete: this extension could not read severity, description provenance.',
  ]);
});

test('a pull request state that went unread raises the banner and a warning', () => {
  const built = build(withUnreadPullState());
  assert.deepStrictEqual(texts(built, '.bghsa-banner'), [
    'Incomplete: this extension could not read pull request state.',
  ]);
  assert.deepStrictEqual(texts(built, '.bghsa-warning:not(.bghsa-banner)'), [
    'A pull request named a state this extension does not read.',
  ]);
});

test('a published advisory shows its assigned CVE and reads everything', () => {
  const built = build(published);
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), [
    'State: Published',
    'Severity: Moderate',
    'CVE: CVE-2026-31984',
  ]);
  assert.deepStrictEqual(texts(built, '.bghsa-banner'), []);
  assert.deepStrictEqual(texts(built, '.bghsa-warning'), []);
});

test('a document that is not an advisory detail page gets no panel', () => {
  for (const name of ['list-page-triage.html', 'list-page-draft.html', 'edit-form.html']) {
    const doc = parseFixture(name);
    assert.ok(panel.render(doc) === null, name);
    assert.ok(doc.getElementById('bghsa-detail-panel') === null, name);
  }
});

test('the values the panel could not read are named once each', () => {
  assert.deepStrictEqual(panel.missingValues(draft, derive.derive(draft)), ['severity']);
  assert.deepStrictEqual(panel.missingValues(published, derive.derive(published)), []);
  const unread = withUnreadPullState();
  assert.deepStrictEqual(panel.missingValues(unread, derive.derive(unread)), [
    'pull request state',
  ]);
});

test('a panel no longer sitting at its anchor is put back there', () => {
  const doc = page();
  const injected = place(doc);
  const parent = /** @type {Element} */ (injected.parentElement);
  parent.append(injected);
  assert.strictEqual(panel.outOfPlace(doc), true);

  place(doc);
  assert.strictEqual(doc.querySelectorAll('#bghsa-detail-panel').length, 1);
  const placed = /** @type {Element} */ (doc.getElementById('bghsa-detail-panel'));
  assert.match(
    placed.nextElementSibling?.getAttribute('data-url') ?? '',
    /partial=repository_advisory%2Fbody$/
  );
  assert.strictEqual(panel.outOfPlace(doc), false);
});

test('advisory content swapped in after load gets a panel with no reload', () => {
  reset(triageDoc);
  const content = /** @type {Element} */ (
    triageDoc.querySelector('div.new-discussion-timeline')
  );
  const host = /** @type {ParentNode} */ (content.parentNode);
  content.remove();

  assert.ok(panel.render(triageDoc) === null, 'content that is gone still rendered a panel');
  assert.ok(
    triageDoc.getElementById('bghsa-detail-panel') === null,
    'a panel is still in the document'
  );
  assert.strictEqual(panel.outOfPlace(triageDoc), true);

  host.append(content);
  const injected = panel.render(triageDoc);
  assert.ok(injected !== null, 'swapped-in content got no panel');
  assert.strictEqual(triageDoc.querySelectorAll('#bghsa-detail-panel').length, 1);
  assert.deepStrictEqual(
    texts(/** @type {Element} */ (injected), '.Box-header .Label'),
    ['State: Triage', 'Severity: High', 'CVE: none']
  );
  assert.strictEqual(panel.outOfPlace(triageDoc), false);
});
