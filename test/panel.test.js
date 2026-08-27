'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const derive = require('../src/common/derive.js');
const merge = require('../src/common/merge.js');
const schema = require('../src/common/schema.js');
const dom = require('../src/common/dom.js');
const panel = require('../src/detail/panel.js');
const tracking = require('../src/detail/tracking.js');
const preserve = require('../src/detail/preserve.js');
const members = require('../src/common/members.js');
const branches = require('../src/common/branches.js');

const { fakeStorage } = require('../test-support/storage.js');

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
 * @param {import('../src/detail/tracking.js').TrackingView} [view] the tracking
 *   state to render, defaulting to an advisory no snapshot holds state for.
 * @returns {Element} the panel this advisory renders to.
 */
function build(advisory, view = tracking.untracked()) {
  return panel.buildPanel(blank, advisory, derive.derive(advisory), view);
}

/**
 * The panel an advisory renders to with the tracking state its own page
 * carries.
 *
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @returns {Promise<Element>}
 */
async function buildTracked(advisory) {
  const merged = merge.mergeSnapshots(advisory.comments);
  return build(advisory, await tracking.readAdvisory(advisory, merged));
}

/**
 * The panel with its editing controls. `buildPanel` builds them only when it is
 * handed the context a write reads, so a panel built any other way has none.
 *
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @returns {Promise<Element>} the panel this advisory renders to.
 */
async function buildEditable(advisory) {
  const merged = merge.mergeSnapshots(advisory.comments);
  const view = await tracking.readAdvisory(advisory, merged);
  const derived = derive.derive(advisory);
  return panel.buildPanel(blank, advisory, derived, view, {
    advisory,
    derived,
    tracking: view,
    fingerprints: await tracking.fingerprints(advisory),
    merged,
  });
}

/**
 * @param {Document} doc
 * @param {import('../src/common/parse-detail.js').ParsedDetail} [advisory]
 * @returns {Element} the panel placed in `doc`.
 */
function place(doc, advisory = triage) {
  const injected = panel.injectPanel(doc, advisory, derive.derive(advisory), tracking.untracked());
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

/**
 * @param {Element} root
 * @param {string} label the panel row's label.
 * @returns {{ text: string, classes: string }} the one chip that row carries.
 */
function rowChip(root, label) {
  for (const row of root.querySelectorAll('.Box-row')) {
    if (text(row.querySelector('.bghsa-label')) !== label) continue;
    const chips = row.querySelectorAll('.Label');
    if (chips.length !== 1) throw new Error(`the ${label} row carries ${chips.length} chips`);
    const chip = /** @type {Element} */ (chips[0]);
    return { text: text(chip), classes: String(chip.getAttribute('class') ?? '') };
  }
  throw new Error(`no panel row labelled ${label}`);
}

/**
 * The panel `advisory` renders to with `payload` holding its tracking state,
 * judged against the values `advisory` itself carries.
 *
 * @param {import('../src/common/parse-detail.js').ParsedDetail} advisory
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Element>}
 */
async function buildWith(advisory, payload) {
  return build(advisory, tracking.read(payload, await tracking.fingerprints(advisory)));
}

/**
 * @param {Element} root
 * @param {string} name the track's name in the confirmation block.
 * @returns {{ chip: string, classes: string, note: string }}
 */
function confirmation(root, name) {
  for (const line of root.querySelectorAll('.bghsa-confirmation')) {
    if (text(line.querySelector('.bghsa-confirmation-name')) !== name) continue;
    const label = line.querySelector('.Label');
    return {
      chip: text(label),
      classes: String(label?.getAttribute('class') ?? ''),
      note: text(line.querySelector('.bghsa-confirmation-note')),
    };
  }
  throw new Error(`no confirmation line for ${name}`);
}

/**
 * @param {Element} root
 * @returns {string[]} the labels of the rows the panel carries.
 */
function rowLabels(root) {
  return texts(root, '.Box-row .bghsa-label');
}

/**
 * The advisory the triage fixture reads to with one metadata field renamed,
 * which is what a GitHub change to the form looks like to the parser.
 *
 * @param {string} name The field name inside `repository_advisory[...]`.
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function withRenamedField(name) {
  const field = triageDoc.querySelector(`[name="repository_advisory[${name}]"]`);
  if (field === null) throw new Error(`the triage fixture carries no ${name} field`);
  field.setAttribute('name', `repository_advisory[${name}-renamed]`);
  try {
    const parsed = parse.parseDetail(triageDoc);
    if (parsed === null) throw new Error('the triage fixture stopped parsing');
    return parsed;
  } finally {
    field.setAttribute('name', `repository_advisory[${name}]`);
  }
}

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

test('an embargo whose lift date has gone by carries a chip in a state color', async () => {
  const built = await buildWith(triage, { embargo: { lift: '2000-01-01' } });
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), ['Embargo overdue']);
  assert.strictEqual(
    chipClass(built, 'Embargo overdue'),
    'Label Label--secondary bghsa-tone-danger'
  );
});

test('an embargo still in force carries no chip', async () => {
  const built = await buildWith(triage, { embargo: { lift: '2999-12-31' } });
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), []);
});

test('an embargo past its lift date does not look like one in force', async () => {
  const built = await buildWith(triage, { embargo: { lift: '2000-01-01' } });
  assert.deepStrictEqual(rowChip(built, 'Embargo'), {
    text: 'Lifts 2000-01-01',
    classes: 'Label Label--secondary bghsa-tone-danger',
  });
});

test('an embargo with no lift date is a chip saying so', async () => {
  const built = await buildWith(triage, { embargo: {} });
  assert.deepStrictEqual(rowChip(built, 'Embargo'), {
    text: 'In force, no lift date',
    classes: 'Label Label--secondary bghsa-tone-attention',
  });
});

test('an advisory with no embargo carries no overdue chip', async () => {
  const built = await buildWith(triage, { triage: 'evaluating' });
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), []);
});

test('the panel reports whether the description is the original text', () => {
  assert.strictEqual(rowText(build(triage), 'Description'), 'Not updated');
  assert.strictEqual(rowText(build(draft), 'Description'), 'Updated');
});

test('the panel leads with the three confirmations', () => {
  const built = build(published);
  assert.deepStrictEqual(texts(built, '.bghsa-confirmation-name'), [
    'Advisory title',
    'Advisory description',
    'Severity and CVSS vector',
  ]);
  const first = built.querySelector('.Box-header')?.nextElementSibling;
  assert.ok(
    first?.classList.contains('bghsa-confirmed') === true,
    'the confirmations are not the first thing under the chip row'
  );
});

test('a confirmed value names who confirmed it and when', async () => {
  const fingerprint = await schema.fingerprint(triage.title);
  assert.ok(fingerprint === '8ae5d80140a5', `the title fingerprint reads ${fingerprint}`);
  const built = await buildWith(triage, {
    confirmed: { title: { by: 'samuelkarp', at: '2026-08-25T18:04:11Z', fp: fingerprint } },
  });
  const title = confirmation(built, 'Advisory title');
  assert.ok(title.chip === 'Confirmed', `the title chip reads ${title.chip}`);
  assert.ok(title.classes === 'Label Label--secondary', `a confirmed chip is toned: ${title.classes}`);
  assert.ok(
    title.note === 'samuelkarp confirmed this value on 2026-08-25 18:04 UTC.',
    `the note reads ${title.note}`
  );
  assert.deepStrictEqual(texts(built, '.bghsa-warning'), []);
});

test('a value changed after it was confirmed reverts to unconfirmed', async () => {
  const fingerprint = await schema.fingerprint(triage.title);
  const confirmed = {
    confirmed: { title: { by: 'samuelkarp', at: '2026-08-25T18:04:11Z', fp: fingerprint } },
  };
  const rewritten = { ...triage, title: `${triage.title} in the drawer handler` };
  const built = await buildWith(rewritten, confirmed);
  const title = confirmation(built, 'Advisory title');
  assert.ok(title.chip === 'Not confirmed', `the title chip reads ${title.chip}`);
  assert.ok(
    title.classes === 'Label Label--secondary',
    `the drifted chip is toned: ${title.classes}`
  );
  assert.ok(title.note === '', `the drifted track carries a note: ${title.note}`);
  assert.deepStrictEqual(texts(built, '.bghsa-warning'), []);
});

test('a confirmation whose current value went unread is not checked', async () => {
  const built = await buildWith(
    { ...triage, title: null },
    { confirmed: { title: { by: 'samuelkarp', at: '2026-08-25T18:04:11Z', fp: 'aaaaaaaaaaaa' } } }
  );
  const title = confirmation(built, 'Advisory title');
  assert.ok(title.chip === 'Not checked', `the title chip reads ${title.chip}`);
  assert.ok(
    title.classes === 'Label Label--secondary',
    `the unchecked chip is toned: ${title.classes}`
  );
  assert.ok(
    title.note ===
      'samuelkarp confirmed a value on 2026-08-25 18:04 UTC. The value on the page' +
        ' could not be read.',
    `the note reads ${title.note}`
  );
});

test('a scoring source the form does not carry reads as unread, not as drift', async () => {
  const unread = withRenamedField('severity');
  assert.strictEqual(unread.severityFieldPresent, false);
  assert.strictEqual(unread.cvssV3Present, true);

  const built = await buildWith(unread, {
    confirmed: {
      scoring: {
        by: 'dmcgowan',
        at: '2026-08-21T14:02:00Z',
        fp: await schema.scoringFingerprint(triage.severityField, triage.cvssV3),
      },
    },
  });
  const scoring = confirmation(built, 'Severity and CVSS vector');
  assert.ok(scoring.chip === 'Not checked', `the scoring chip reads ${scoring.chip}`);
  assert.ok(
    scoring.classes === 'Label Label--secondary',
    `the scoring chip is toned: ${scoring.classes}`
  );
  assert.ok(
    scoring.note ===
      'dmcgowan confirmed a value on 2026-08-21 14:02 UTC. The value on the page' +
        ' could not be read.',
    `the note reads ${scoring.note}`
  );
  assert.deepStrictEqual(texts(built, '.bghsa-banner'), [
    'Incomplete: this extension could not read severity selection.',
  ]);
});

test('a CVSS vector field the form does not carry raises the banner', async () => {
  const unread = withRenamedField('cvss_v3');
  assert.strictEqual(unread.cvssV3Present, false);
  assert.deepStrictEqual(panel.missingValues(unread, derive.derive(unread)), ['CVSS vector']);
  assert.strictEqual(
    (await tracking.fingerprints(unread)).scoring,
    null,
    'a vector that was not read still fingerprinted'
  );
  const built = build(unread);
  assert.deepStrictEqual(texts(built, '.bghsa-banner'), [
    'Incomplete: this extension could not read CVSS vector.',
  ]);
});

test('the stored tracks the triage advisory carries are shown', async () => {
  const built = await buildTracked(triage);
  assert.deepStrictEqual(rowLabels(built), [
    'Triage',
    'Owners',
    'Backport targets',
    'Embargo',
    'Description',
    'Original report',
  ]);
  assert.deepStrictEqual(texts(built, '.Box-row:not(.bghsa-confirmed) .bghsa-chips .Label'), [
    'Awaiting reporter',
    'samuelkarp',
    'release/1.0',
    'Lifts 2026-09-30',
  ]);
  assert.deepStrictEqual(texts(built, '.bghsa-since'), ['since 2026-08-25 18:04 UTC']);
  assert.strictEqual(rowText(built, 'Embargo'), 'Lifts 2026-09-30');
});

test('a track the snapshot says nothing about carries no row', () => {
  assert.deepStrictEqual(rowLabels(build(draft)), ['Description', 'Original report']);
});

test('the editing controls start collapsed', async () => {
  const built = await buildEditable(triage);

  // The panel is for reading state, so the controls that change it are behind
  // a disclosure the reader opens. What is behind it is the editing form, not
  // an empty box: the select that stages the triage state is inside.
  const disclosure = built.querySelector('.bghsa-editor details');
  if (disclosure === null) throw new Error('the panel carries no editing disclosure');
  const open = disclosure.getAttribute('open');
  assert.ok(open === null, `the editing disclosure's open attribute: ${open}`);
  assert.ok(
    disclosure.querySelector('select.bghsa-triage') !== null,
    'the disclosure holds none of the editing controls'
  );
});

test('a closed advisory shows the reason and what it duplicates', async () => {
  const built = await buildWith(triage, {
    triage: 'evaluating',
    closure: { reason: 'duplicate', duplicateOf: 'GHSA-cm76-qm8v-3j95' },
  });
  assert.strictEqual(rowText(built, 'Closed as'), 'Duplicateof GHSA-cm76-qm8v-3j95');
});

test('a chip carrying a stored value is sentence-cased, and a login is not', async () => {
  assert.strictEqual(panel.sentenceCase('awaiting reporter'), 'Awaiting reporter');
  assert.strictEqual(panel.sentenceCase('not a vulnerability'), 'Not a vulnerability');
  assert.strictEqual(panel.sentenceCase('Already capital'), 'Already capital');
  assert.strictEqual(panel.sentenceCase(''), '');
  const built = await buildWith(triage, {
    triage: 'awaiting reporter',
    owners: ['samuelkarp'],
    backports: ['release/1.0'],
    closure: { reason: 'no reporter response' },
  });
  assert.deepStrictEqual(texts(built, '.Box-row:not(.bghsa-confirmed) .bghsa-chips .Label'), [
    'Awaiting reporter',
    'samuelkarp',
    'release/1.0',
    'No reporter response',
  ]);
});

test('the panel does not list the snapshots it read', async () => {
  const built = await buildTracked(triage);
  const rendered = text(built);
  assert.ok(
    !rendered.includes('282848'),
    'the panel names a comment the snapshots came from'
  );
  assert.ok(
    !rendered.includes('prakleumas'),
    'the panel names the author of an untrusted snapshot'
  );
});

test('the panel sits in the main column, above the description Box, outside both live regions', async () => {
  reset(triageDoc);
  const injected = await panel.render(triageDoc);
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

test('a severity that cannot be read raises the banner, which no chip carries', () => {
  const built = build(draft);
  assert.strictEqual(draft.severityLabel, null);
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), []);
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

test('a published advisory reads every value it displays', () => {
  const built = build(published);
  assert.deepStrictEqual(texts(built, '.Box-header .Label'), []);
  assert.deepStrictEqual(texts(built, '.bghsa-banner'), []);
  assert.deepStrictEqual(texts(built, '.bghsa-warning'), []);
});

test('a document that is not an advisory detail page gets no panel', async () => {
  for (const name of ['list-page-triage.html', 'list-page-draft.html', 'edit-form.html']) {
    const doc = parseFixture(name);
    assert.ok((await panel.render(doc)) === null, name);
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

test('advisory content swapped in after load gets a panel with no reload', async () => {
  reset(triageDoc);
  const content = /** @type {Element} */ (
    triageDoc.querySelector('div.new-discussion-timeline')
  );
  const host = /** @type {ParentNode} */ (content.parentNode);
  content.remove();

  assert.ok((await panel.render(triageDoc)) === null, 'content that is gone still rendered a panel');
  assert.ok(
    triageDoc.getElementById('bghsa-detail-panel') === null,
    'a panel is still in the document'
  );
  assert.strictEqual(panel.outOfPlace(triageDoc), true);

  host.append(content);
  const injected = await panel.render(triageDoc);
  assert.ok(injected !== null, 'swapped-in content got no panel');
  assert.strictEqual(triageDoc.querySelectorAll('#bghsa-detail-panel').length, 1);
  assert.strictEqual(rowText(/** @type {Element} */ (injected), 'Description'), 'Not updated');
  assert.strictEqual(panel.outOfPlace(triageDoc), false);
});

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs the event loop until `ready` holds, or until the wait runs out, so an
 * assertion made afterwards reads a settled document.
 *
 * @param {() => boolean} ready
 * @returns {Promise<void>}
 */
async function until(ready) {
  const deadline = Date.now() + 2000;
  while (!ready() && Date.now() < deadline) await delay(5);
}

/**
 * @param {string} suffix The end of the region's `data-url`.
 * @returns {Element} the live region the triage fixture carries under it.
 */
function region(suffix) {
  const found = triageDoc.querySelector(`div.js-socket-channel[data-url$="${suffix}"]`);
  if (found === null) throw new Error(`the triage fixture carries no ${suffix} region`);
  return found;
}

/**
 * @returns {number} how many snapshot chips the document carries.
 */
function chipCount() {
  return triageDoc.querySelectorAll(`[${parse.EXTENSION_CHIP_ATTRIBUTE}]`).length;
}

/**
 * A copy of `source` as GitHub would send it: the extension's chips are not in
 * the markup GitHub renders.
 *
 * @param {Element} source
 * @returns {Element}
 */
function refreshedCopy(source) {
  const copy = /** @type {Element} */ (source.cloneNode(true));
  for (const chip of copy.querySelectorAll(`[${parse.EXTENSION_CHIP_ATTRIBUTE}]`)) chip.remove();
  return copy;
}

test('a live region whose content is replaced marks its snapshots again', async () => {
  reset(triageDoc);
  const timeline = region('timeline');
  const refreshed = refreshedCopy(timeline);
  await panel.render(triageDoc);
  const marked = chipCount();
  assert.ok(marked > 0, 'the triage fixture marked no snapshot');

  const observer = panel.observe(triageDoc);
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    timeline.replaceWith(refreshed);
    assert.strictEqual(chipCount(), 0, 'the refreshed region arrived carrying chips');
    assert.strictEqual(panel.outOfPlace(triageDoc), false, 'the refresh moved the panel');
    await until(() => chipCount() > 0);
    assert.strictEqual(chipCount(), marked);
  } finally {
    observer?.disconnect();
  }
});

test('a severity a live region stopped carrying reaches the banner', async () => {
  reset(triageDoc);
  const title = region('title');
  const refreshed = refreshedCopy(title);
  const severity = refreshed.querySelector('.Label--large');
  if (severity === null) throw new Error('the title region carries no severity label');
  severity.remove();

  const injected = await panel.render(triageDoc);
  assert.ok(injected !== null, 'render placed no panel');
  const banners = () =>
    texts(/** @type {Element} */ (triageDoc.getElementById(panel.PANEL_ID)), '.bghsa-banner');
  assert.deepStrictEqual(banners(), []);

  const observer = panel.observe(triageDoc);
  try {
    title.replaceWith(refreshed);
    await until(() => banners().length > 0);
    assert.deepStrictEqual(banners(), [
      'Incomplete: this extension could not read severity.',
    ]);
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
  } finally {
    observer?.disconnect();
    refreshed.replaceWith(title);
  }
});

test("the extension's own writing schedules no pass", async () => {
  reset(triageDoc);
  const fingerprints = tracking.fingerprints;
  let passes = 0;
  globalThis.bghsa.tracking.fingerprints = (advisory) => {
    passes += 1;
    return fingerprints(advisory);
  };
  const observer = panel.observe(triageDoc);
  try {
    await panel.render(triageDoc);
    assert.strictEqual(passes, 1);
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, 1, `the extension's own writing ran ${passes - 1} more passes`);
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
  } finally {
    observer?.disconnect();
    globalThis.bghsa.tracking.fingerprints = fingerprints;
  }
});

test('the observer runs its passes through the loop it is given', async () => {
  const doc = page();
  let passes = 0;
  const observer = panel.observe(doc, async () => {
    passes += 1;
  });
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    doc.body?.append(doc.createElement('div'));
    await until(() => passes > 0);
    assert.strictEqual(passes, 1);
  } finally {
    observer?.disconnect();
  }
});

test('a pass reads the document alone, and a request during one folds into one more', async () => {
  reset(triageDoc);
  const fingerprints = tracking.fingerprints;
  let reading = 0;
  let overlaps = 0;
  let passes = 0;
  globalThis.bghsa.tracking.fingerprints = async (advisory) => {
    passes += 1;
    reading += 1;
    if (reading > 1) overlaps += 1;
    await delay(5);
    const read = await fingerprints(advisory);
    reading -= 1;
    return read;
  };
  try {
    const pass = panel.renderLoop(triageDoc);
    await Promise.all([pass(), pass(), pass()]);
    await until(() => reading === 0 && passes >= 2);
    assert.strictEqual(overlaps, 0, 'two passes read the document together');
    assert.strictEqual(passes, 2, `three requests ran ${passes} passes`);
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.STYLE_ID}`).length, 1);
    assert.strictEqual(chipCount(), 1);
  } finally {
    globalThis.bghsa.tracking.fingerprints = fingerprints;
  }
});

/**
 * @param {Document} doc
 * @param {string} name The class stem of the control to read.
 * @returns {string[]} the values that control offers in the panel the document
 *   carries.
 */
function offered(doc, name) {
  const placed = doc.getElementById(panel.PANEL_ID);
  if (placed === null) return [];
  return Array.from(placed.querySelectorAll(`datalist.bghsa-${name}-candidates option`)).map(
    (option) => String(option.getAttribute('value') ?? '')
  );
}

test('a member storage holds and this page does not reaches the panel', async () => {
  reset(triageDoc);
  members.clear();
  members.setStorage(fakeStorage({ [members.MEMBERS_KEY]: { 'git-utensils': ['dmcgowan'] } }));
  try {
    const drawn = await panel.render(triageDoc);
    assert.ok(drawn !== null, 'the triage fixture offered no anchor');
    await until(() => offered(triageDoc, 'owner').includes('dmcgowan'));
    assert.strictEqual(
      offered(triageDoc, 'owner').join(' '),
      'samuelkarp dmcgowan',
      'the stored login is not offered as an owner'
    );
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
  } finally {
    members.setStorage(null);
    members.clear();
    reset(triageDoc);
  }
});

test('a branch storage holds and this page does not reaches the panel', async () => {
  reset(triageDoc);
  branches.clear();
  const key = branches.keyOf({ owner: 'git-utensils', repo: 'Spoon-Knife' });
  assert.ok(key !== null, 'the repository has no branch key');
  branches.setStorage(fakeStorage({ [branches.BRANCHES_KEY]: { [key]: ['release/2.10'] } }));
  try {
    const drawn = await panel.render(triageDoc);
    assert.ok(drawn !== null, 'the triage fixture offered no anchor');
    await until(() => offered(triageDoc, 'backport').includes('release/2.10'));
    assert.strictEqual(
      offered(triageDoc, 'backport').join(' '),
      'release/2.10 release/1.0',
      'the stored branch is not offered as a backport target'
    );
    assert.strictEqual(triageDoc.querySelectorAll(`#${panel.PANEL_ID}`).length, 1);
  } finally {
    branches.setStorage(null);
    branches.clear();
    reset(triageDoc);
  }
});

/** The advisory the fixtures come from, which is on the allowlist. */
const DETAIL = '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj';

/** An advisory detail page holding what a write reads from one. */
const ADVISORY_PAGE = [
  '<!doctype html><html><body>',
  '<div class="gh-header-meta"><span class="State">Triage</span>',
  '<span class="Label--large" title="Severity: High">High</span>',
  '<span class="user-select-contain">GHSA-jmvx-2wfw-xfgj</span></div>',
  `<div class="js-socket-channel js-updatable-content" data-url="${DETAIL}/repository_advisory/body">`,
  '<div class="Box"><div class="js-repository-advisory-details">',
  '<div class="Box-header timeline-comment-header">',
  '<a class="author" href="/prakleumas">prakleumas</a>',
  '<span class="js-comment-edit-history"></span></div>',
  '<form><input name="repository_advisory[title]" value="Path traversal in the drawer handler">',
  '<textarea name="repository_advisory[description]">The handler joins a path.</textarea>',
  '</form></div></div></div>',
  `<form class="js-advisory-comment-form" action="${DETAIL}/comments">`,
  '<input type="hidden" name="authenticity_token" value="a-token">',
  '<textarea name="body"></textarea>',
  '<button type="submit" name="comment" value="1" disabled>Comment</button>',
  '</form></body></html>',
].join('\n');

/**
 * A response holding the comment the write claims to have made, carrying the
 * marker that write drew.
 *
 * @param {RequestInit} init The write request.
 * @returns {string}
 */
function wroteHtml(init) {
  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (init.body));
  const found = new RegExp(`${preserve.MARKER_PREFIX}[0-9a-f]+`).exec(String(sent.get('body')));
  return (
    '<!doctype html><html><body><div class="comment-body markdown-body js-comment-body"><details>' +
    `<summary>${preserve.PRESERVE_SUMMARY}</summary>` +
    `<p><code>${found === null ? '' : found[0]}</code></p>` +
    `<p>${preserve.TITLE_LABEL}</p><p>Path traversal in the drawer handler</p>` +
    `<p>${preserve.DESCRIPTION_LABEL}</p><p>The handler joins a path.</p>` +
    '</details></div></body></html>'
  );
}

/** Answering a write with the comment it wrote. */
const WROTE = null;

/**
 * A stand-in for `fetch` answering the advisory page with `page` and the write
 * with `body`.
 *
 * @param {number} status The status the write is answered with.
 * @param {string | null} body The markup the write is answered with, or null
 *   for the comment that write wrote.
 * @param {string} [page] The markup the advisory page is answered with.
 * @returns {{ send: import('../src/common/write.js').WriteFetch, calls: Array<{ url: string, init: RequestInit }>, posts: () => Array<{ url: string, init: RequestInit }> }}
 */
function fakeFetch(status, body, page) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  return {
    calls,
    posts: () => calls.filter((call) => call.init.method === 'POST'),
    send: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') {
        const answer = page ?? ADVISORY_PAGE;
        return { status: 200, text: async () => answer };
      }
      const answer = body ?? wroteHtml(init);
      return { status, text: async () => answer };
    },
  };
}

/**
 * @param {string} markup
 * @returns {Document}
 */
function asDocument(markup) {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(markup).document));
}

/** An advisory in a repository writes are not permitted on. */
const elsewhere = {
  ...triage,
  ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' },
};

/** The advisory as it stands once the preservation comment is on it. */
const preserved = {
  ...triage,
  comments: [
    {
      ...(/** @type {import('../src/common/parse-detail.js').ParsedComment} */ (
        triage.comments[0]
      )),
      text: `Original report preserved by Better GHSA ${preserve.MARKER_PREFIX}0f0f0f0f0f0f0f0f`,
    },
  ],
};

/**
 * @param {Element} root
 * @returns {Element} the preservation button in a panel.
 */
function preserveButton(root) {
  const button = root.querySelector('button.bghsa-preserve');
  if (button === null) throw new Error('the panel offers no preservation button');
  return button;
}

/**
 * @returns {Promise<void>} resolves once the click handler has run to the end.
 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('an advisory that already carries the comment links to it', () => {
  const built = build(preserved);
  assert.strictEqual(built.querySelector('button.bghsa-preserve'), null);
  assert.strictEqual(rowText(built, 'Original report'), 'Preserved');
  const link = built.querySelector('.Box-row a.bghsa-preserved');
  assert.ok(link !== null, 'the row carries no link to the comment');
  assert.strictEqual(
    link?.getAttribute('href'),
    `#${preserved.comments[0]?.elementId}`,
    'the link does not point at the comment holding the report'
  );
});

test('the button on a repository off the allowlist writes nothing and says why', async () => {
  preserve.attempts.clear();
  const built = build(elsewhere);
  const button = /** @type {HTMLElement} */ (
    /** @type {unknown} */ (preserveButton(built))
  );
  button.click();
  await settle();

  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    "Nothing was written: someone/else is not on this extension's allowlist.",
  ]);
  assert.strictEqual(button.hasAttribute('disabled'), false);
  assert.ok(built.contains(button), 'the button was taken out of the panel');
});

test('a press that could not tell the provenance writes nothing and says why', async () => {
  preserve.attempts.clear();
  const built = build({ ...triage, descriptionOriginal: null });
  const button = preserveButton(built);
  const fake = fakeFetch(200, WROTE);
  const outcome = await panel.press(blank, { ...triage, descriptionOriginal: null }, button, {
    fetch: fake.send,
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'provenance');
  assert.strictEqual(fake.calls.length, 0);
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    "Nothing was written: this extension could not tell whether the description is the reporter's original text.",
  ]);
  assert.strictEqual(button.hasAttribute('disabled'), false);
});

test('a press that wrote the comment takes the button away and says so', async () => {
  preserve.attempts.clear();
  const built = build(triage);
  const button = preserveButton(built);
  const fake = fakeFetch(200, WROTE);
  const outcome = await panel.press(blank, triage, button, {
    fetch: fake.send,
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(fake.posts().length, 1);
  assert.strictEqual(built.querySelector('button.bghsa-preserve'), null);
  assert.strictEqual(rowText(built, 'Original report'), 'The original report is preserved.');
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), []);
});

test('a press whose result GitHub did not confirm leaves the button pressed', async () => {
  preserve.attempts.clear();
  const built = build(triage);
  const button = preserveButton(built);
  const fake = fakeFetch(200, '<!doctype html><html><body>nothing</body></html>');
  const outcome = await panel.press(blank, triage, button, {
    fetch: fake.send,
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unwritten');
  assert.strictEqual(button.hasAttribute('disabled'), true);
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    'The write could not be confirmed: GitHub answered without the comment.' +
      ' Reload the page to see whether the comment was created.',
  ]);
});

test('a panel rebuilt after a press that wrote offers no button', async () => {
  preserve.attempts.clear();
  const built = build(triage);
  const fake = fakeFetch(200, WROTE);
  const outcome = await panel.press(blank, triage, preserveButton(built), {
    fetch: fake.send,
    parseDocument: asDocument,
  });
  assert.strictEqual(outcome.ok, true);

  const again = build(triage);
  assert.strictEqual(again.querySelector('button.bghsa-preserve'), null);
  assert.strictEqual(rowText(again, 'Original report'), 'The original report is preserved.');
  preserve.attempts.clear();
});

test('a failed press leaves one result, not one per press', async () => {
  preserve.attempts.clear();
  const built = build(elsewhere);
  const button = preserveButton(built);
  for (const round of [1, 2, 3]) {
    const outcome = await panel.press(blank, elsewhere, button, {
      fetch: fakeFetch(200, WROTE).send,
      parseDocument: asDocument,
    });
    assert.strictEqual(outcome.reason, 'allowlist', `round ${round}`);
    assert.strictEqual(
      built.querySelectorAll('.bghsa-preserve-result').length,
      1,
      `round ${round} left more than one result`
    );
  }
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    "Nothing was written: someone/else is not on this extension's allowlist.",
  ]);
});

test('a press that read the comment already on the advisory takes the button away', async () => {
  preserve.attempts.clear();
  const preservedPage = ADVISORY_PAGE.replace(
    '<form class="js-advisory-comment-form"',
    '<div class="timeline-comment-group" id="advisory-comment-42">' +
      '<div class="comment-body markdown-body js-comment-body">' +
      `${preserve.PRESERVE_SUMMARY}<code>${preserve.MARKER_PREFIX}0f0f0f0f0f0f0f0f</code>` +
      '</div></div>' +
      '<form class="js-advisory-comment-form"'
  );
  const built = build(triage);
  const button = preserveButton(built);
  const fake = fakeFetch(200, WROTE, preservedPage);
  const outcome = await panel.press(blank, triage, button, {
    fetch: fake.send,
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'preserved');
  assert.strictEqual(fake.posts().length, 0);
  assert.strictEqual(built.querySelector('button.bghsa-preserve'), null);
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), []);
  assert.strictEqual(rowText(built, 'Original report'), 'The original report is already preserved.');
  preserve.attempts.clear();
});

test('a press that could not read the advisory page can be pressed again', async () => {
  preserve.attempts.clear();
  const built = build(triage);
  const button = preserveButton(built);
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  const outcome = await panel.press(blank, triage, button, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 503, text: async () => '' };
    },
    parseDocument: asDocument,
  });

  assert.strictEqual(outcome.reason, 'fetch');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(button.hasAttribute('disabled'), false);
  assert.deepStrictEqual(texts(built, '.bghsa-preserve-result'), [
    'Nothing was written: GitHub answered 503 for the advisory page.',
  ]);
  preserve.attempts.clear();
});
