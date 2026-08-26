'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const derive = require('../src/common/derive.js');
const panel = require('../src/detail/panel.js');
const preserve = require('../src/detail/preserve.js');

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

/** A response holding the comment the write claims to have made. */
const WROTE =
  '<!doctype html><html><body><div class="comment-body markdown-body js-comment-body"><details>' +
  `<summary>${preserve.PRESERVE_SUMMARY}</summary><p>${preserve.TITLE_NOTE}</p>` +
  `<p>${preserve.ORIGINAL_NOTE}</p></details></div></body></html>`;

/**
 * A stand-in for `fetch` answering the advisory page with `page` and the write
 * with `body`.
 *
 * @param {number} status The status the write is answered with.
 * @param {string} body The markup the write is answered with.
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
      return { status, text: async () => body };
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
      text: 'Original report preserved by Better GHSA Title Path traversal',
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

test('an advisory that already carries the comment is offered no button', () => {
  const built = build(preserved);
  assert.strictEqual(built.querySelector('button.bghsa-preserve'), null);
  assert.strictEqual(rowText(built, 'Original report'), 'The original report is already preserved.');
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
      `${preserve.PRESERVE_SUMMARY}</div></div>` +
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
