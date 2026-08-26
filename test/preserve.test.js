'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const preserve = require('../src/detail/preserve.js');

/**
 * @param {string} name
 * @returns {Document}
 */
function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * @param {string} markup
 * @returns {Document}
 */
function document(markup) {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(markup).document));
}

/**
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function record(name) {
  const parsed = parse.parseDetail(fixture(name));
  if (parsed === null) throw new Error(`${name} is not an advisory detail page`);
  return parsed;
}

/** The one parse of each large fixture in this file. */
const triage = record('triage-thread.html');
const draft = record('draft.html');

/** The advisory the fixtures come from, which is on the allowlist. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-jmvx-2wfw-xfgj' };

/** The path of that advisory's detail page. */
const DETAIL = '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj';

/** The title the built page carries. */
const TITLE = 'Path traversal in the drawer handler';

/** The description the built page carries. */
const DESCRIPTION = '### Summary\n\nThe handler joins a path without normalizing it.';

/**
 * @param {string} value
 * @returns {string} `value` with the characters markup reads escaped.
 */
function escape(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @typedef {object} PageOptions
 * @property {string} [title]
 * @property {string} [description]
 * @property {boolean} [revised] Whether the description carries a revision.
 * @property {boolean} [preserved] Whether the thread carries the comment.
 * @property {string} [detail] The path the live region names.
 * @property {string} [action] The comment form's action.
 */

/**
 * An advisory detail page holding what this extension reads from one: the
 * reference, the title and description, the description's revision control,
 * the comment thread, and the form a write clones.
 *
 * @param {PageOptions} [options]
 * @returns {string}
 */
function pageHtml(options) {
  const settings = options ?? {};
  const detail = settings.detail ?? DETAIL;
  const action = settings.action ?? `${detail}/comments`;
  const revision =
    settings.revised === true
      ? `<details><summary>edited</summary>` +
        `<details-menu src="${detail}/edit_history_log"></details-menu></details>`
      : '';
  const thread =
    settings.preserved === true
      ? '<div class="timeline-comment-group" id="advisory-comment-42">' +
        '<div class="comment-body markdown-body js-comment-body">' +
        `${preserve.PRESERVE_SUMMARY} Title ${escape(TITLE)}</div></div>`
      : '';
  return [
    '<!doctype html><html><body>',
    '<div class="gh-header-meta">',
    '<span class="State">Triage</span>',
    '<span class="Label--large" title="Severity: High">High</span>',
    '<span class="user-select-contain">GHSA-jmvx-2wfw-xfgj</span>',
    '</div>',
    `<div class="js-socket-channel js-updatable-content" data-url="${detail}/repository_advisory/body">`,
    '<div class="Box">',
    '<div class="js-repository-advisory-details">',
    '<div class="Box-header timeline-comment-header">',
    '<a class="author" href="/prakleumas">prakleumas</a>',
    '<relative-time datetime="2026-08-01T00:00:00Z"></relative-time>',
    `<span class="js-comment-edit-history">${revision}</span>`,
    '</div>',
    '<form>',
    `<input name="repository_advisory[title]" value="${escape(settings.title ?? TITLE)}">`,
    '<textarea name="repository_advisory[description]">',
    escape(settings.description ?? DESCRIPTION),
    '</textarea>',
    '</form>',
    '</div>',
    '</div>',
    '</div>',
    thread,
    `<form class="js-advisory-comment-form" action="${action}">`,
    '<input type="hidden" name="authenticity_token" value="a-token">',
    '<input type="hidden" name="required_field_1234" value="">',
    '<textarea name="body"></textarea>',
    '<button type="submit" name="comment" value="1" disabled>Comment</button>',
    '</form>',
    '</body></html>',
  ].join('\n');
}

/**
 * @param {PageOptions} [options]
 * @returns {import('../src/common/parse-detail.js').ParsedDetail} the advisory
 *   a built page parses to.
 */
function pageRecord(options) {
  const parsed = parse.parseDetail(document(pageHtml(options)));
  if (parsed === null) throw new Error('the built page is not an advisory detail page');
  return parsed;
}

/** The advisory the panel loaded with in most of these tests. */
const advisory = pageRecord();

/**
 * A response holding the comment a write claims to have made, as GitHub
 * renders it.
 *
 * @param {boolean} original Whether the description was the reporter's own.
 * @returns {string}
 */
function wroteHtml(original) {
  return (
    '<!doctype html><html><body>' +
    '<div class="comment-body markdown-body js-comment-body"><details>' +
    `<summary>${preserve.PRESERVE_SUMMARY}</summary>` +
    `<p>${preserve.TITLE_NOTE}</p>` +
    `<p>${original ? preserve.ORIGINAL_NOTE : preserve.REVISED_NOTE}</p>` +
    '</details></div></body></html>'
  );
}

/** The answer to a press on an advisory whose description is the original. */
const WROTE = wroteHtml(true);

/**
 * @typedef {object} Exchange
 * @property {import('../src/common/write.js').WriteFetch} send
 * @property {Array<{ url: string, init: RequestInit }>} calls
 * @property {() => Array<{ url: string, init: RequestInit }>} posts
 */

/**
 * A stand-in for `fetch` answering the detail page with `page` and the write
 * with `answer`.
 *
 * @param {object} [options]
 * @param {string} [options.page] The detail page markup.
 * @param {number} [options.pageStatus]
 * @param {string} [options.answer] The markup the write is answered with.
 * @param {number} [options.status] The status the write is answered with.
 * @param {Promise<void>} [options.holdPage] Awaited before the page answers.
 * @param {Promise<void>} [options.holdWrite] Awaited before the write answers.
 * @returns {Exchange}
 */
function exchange(options) {
  const settings = options ?? {};
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  return {
    calls,
    posts: () => calls.filter((call) => call.init.method === 'POST'),
    send: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'GET') {
        if (settings.holdPage !== undefined) await settings.holdPage;
        const page = settings.page ?? pageHtml();
        return { status: settings.pageStatus ?? 200, text: async () => page };
      }
      if (settings.holdWrite !== undefined) await settings.holdWrite;
      const answer = settings.answer ?? WROTE;
      return { status: settings.status ?? 200, text: async () => answer };
    },
  };
}

/**
 * @param {Exchange} fake
 * @returns {import('../src/detail/preserve.js').PreserveOptions}
 */
function run(fake) {
  return { fetch: fake.send, parseDocument: document };
}

/**
 * @returns {Promise<void>} resolves once every pending microtask has run.
 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The comment an advisory whose description has never been revised gets. */
const ORIGINAL_BODY = [
  '<details>',
  '<summary>Original report preserved by Better GHSA</summary>',
  '',
  'The title below is the advisory title as it stood when this comment was written,' +
    ' because GitHub records no revision signal for a title.',
  '',
  "The description below is the reporter's original text: the advisory description" +
    ' carried no revision when this comment was written.',
  '',
  '---',
  '',
  '**Title**',
  '',
  'Path traversal in the drawer handler',
  '',
  '**Description**',
  '',
  '### Summary',
  '',
  'The handler joins a path without normalizing it.',
  '',
  '</details>',
  '',
].join('\n');

/** The comment an advisory whose description has been revised gets. */
const REVISED_BODY = ORIGINAL_BODY.replace(
  "The description below is the reporter's original text: the advisory description" +
    ' carried no revision when this comment was written.',
  'The description below is the text as it stood when this comment was written.' +
    ' The advisory description has been revised since it was reported.'
);

test('a description that has never been revised is recorded as the original', () => {
  const body = preserve.buildBody(advisory);
  assert.ok(body === ORIGINAL_BODY, `the comment body reads:\n${String(body)}`);
});

test('a description that has been revised is recorded as the text of the moment', () => {
  const body = preserve.buildBody(pageRecord({ revised: true }));
  assert.ok(body === REVISED_BODY, `the comment body reads:\n${String(body)}`);
});

test("this extension's own sentences come before any text the reporter wrote", () => {
  const body = /** @type {string} */ (preserve.buildBody(advisory));
  const summary = body.indexOf(preserve.PRESERVE_SUMMARY);
  const note = body.indexOf(preserve.TITLE_NOTE);
  const provenance = body.indexOf(preserve.ORIGINAL_NOTE);
  const title = body.indexOf(TITLE);
  const description = body.indexOf('The handler joins a path');
  assert.ok(summary < note, 'the title note is above the summary');
  assert.ok(note < provenance, 'the provenance sentences are out of order');
  assert.ok(provenance < title, 'the reporter title is above this extension\'s sentences');
  assert.ok(title < description, 'the description is above the title');
});

test('the comment is one collapsed block carrying the fixed summary', () => {
  const body = /** @type {string} */ (preserve.buildBody(advisory));
  assert.strictEqual(body.startsWith('<details>\n'), true);
  assert.strictEqual(body.trimEnd().endsWith('</details>'), true);
  assert.strictEqual(
    body.includes('<summary>Original report preserved by Better GHSA</summary>'),
    true
  );
  assert.strictEqual(preserve.PRESERVE_SUMMARY, 'Original report preserved by Better GHSA');
});

test('an advisory whose description was edited gets the revised wording', () => {
  const body = /** @type {string} */ (preserve.buildBody(draft));
  assert.strictEqual(draft.descriptionOriginal, false);
  assert.strictEqual(body.includes(preserve.REVISED_NOTE), true);
  assert.strictEqual(body.includes(preserve.ORIGINAL_NOTE), false);
});

test('no comment is built for a description whose provenance did not read', () => {
  assert.strictEqual(preserve.buildBody({ ...advisory, descriptionOriginal: null }), null);
  assert.strictEqual(preserve.buildBody({ ...advisory, title: null }), null);
  assert.strictEqual(preserve.buildBody({ ...advisory, description: null }), null);
});

test('a report carrying its own collapsed blocks keeps them', () => {
  const nested = '<details>\n<summary>Proof of concept</summary>\n\nA log.\n\n</details>';
  assert.strictEqual(preserve.balanceDetails(nested), nested);
  const body = /** @type {string} */ (preserve.buildBody({ ...advisory, description: nested }));
  assert.strictEqual(body.includes(nested), true);
});

test('a closing tag that closes nothing is taken out of the report', () => {
  assert.strictEqual(preserve.balanceDetails('The rest.\n</details>\nSpilled.'),
    'The rest.\n\nSpilled.');
  assert.strictEqual(preserve.balanceDetails('a </DETAILS > b'), 'a  b');
  assert.strictEqual(
    preserve.balanceDetails('<details open>\n</details>\n</details>'),
    '<details open>\n</details>\n'
  );
  const body = /** @type {string} */ (
    preserve.buildBody({ ...advisory, description: 'Report.\n</details>\nSpilled.' })
  );
  assert.strictEqual(body.includes('Report.\n\nSpilled.'), true);
  assert.strictEqual(body.split('</details>').length - 1, 1);
});

test('a closing tag inside code is the reporter showing markup, and stays', () => {
  const fenced = '```html\n</details>\n```';
  assert.strictEqual(preserve.balanceDetails(fenced), fenced);
  assert.strictEqual(preserve.balanceDetails('write `</details>` there'), 'write `</details>` there');
  assert.strictEqual(preserve.balanceDetails('~~~\n</details>\n~~~'), '~~~\n</details>\n~~~');
});

test('a title carrying a closing tag cannot close the block either', () => {
  const body = /** @type {string} */ (
    preserve.buildBody({ ...advisory, title: 'Bug</details>Spilled' })
  );
  assert.strictEqual(body.includes('BugSpilled'), true);
  assert.strictEqual(body.split('</details>').length - 1, 1);
});

test('an advisory with no preservation comment offers the button', () => {
  preserve.attempts.clear();
  const state = preserve.offered(advisory);
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.writable, true);
  assert.strictEqual(state.reason, null);
  assert.strictEqual(state.message, 'Preserve the title and description in a comment.');
});

test('the fixed summary text on a comment is what says the report is preserved', () => {
  const preserved = pageRecord({ preserved: true });
  assert.strictEqual(preserve.hasPreservationComment(advisory.comments), false);
  assert.strictEqual(preserve.hasPreservationComment(preserved.comments), true);

  const state = preserve.offered(preserved);
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'preserved');
  assert.strictEqual(state.message, 'The original report is already preserved.');
});

test('an advisory in a repository off the allowlist offers a button that refuses', () => {
  const elsewhere = {
    ...advisory,
    ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' },
  };
  const state = preserve.offered(elsewhere);
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'allowlist');
  assert.strictEqual(
    state.message,
    "Nothing was written: someone/else is not on this extension's allowlist."
  );
});

test('a description whose provenance did not read refuses the write', () => {
  const state = preserve.offered({ ...advisory, descriptionOriginal: null });
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'provenance');
  assert.strictEqual(
    state.message,
    "Nothing was written: this extension could not tell whether the description is the reporter's original text."
  );
});

test('a title or description that did not read refuses the write', () => {
  for (const record of [
    { ...advisory, title: null },
    { ...advisory, description: null },
  ]) {
    const state = preserve.offered(record);
    assert.strictEqual(state.writable, false);
    assert.strictEqual(state.reason, 'unreadable');
  }
});

test('pressing on an advisory whose provenance did not read sends nothing', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  const outcome = await preserve.preserve(
    { ...advisory, descriptionOriginal: null },
    run(fake)
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'provenance');
  assert.strictEqual(fake.calls.length, 0);
});

test('a press reads the advisory page and writes what that page says', async () => {
  preserve.attempts.clear();
  const fake = exchange({
    page: pageHtml({ title: 'The title as it stands now', revised: true }),
    answer: wroteHtml(false),
  });
  const outcome = await preserve.preserve(advisory, run(fake));

  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.status, 200);
  assert.strictEqual(fake.calls.length, 2);

  const read = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[0]);
  assert.strictEqual(read.url, DETAIL);
  assert.strictEqual(read.init.method, 'GET');
  assert.strictEqual(read.init.credentials, 'same-origin');

  const wrote = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[1]);
  assert.strictEqual(wrote.url, `${DETAIL}/comments`);
  assert.strictEqual(wrote.init.method, 'POST');
  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (wrote.init.body));
  const body = String(sent.get('body'));
  assert.ok(
    body.includes('The title as it stands now'),
    'the comment carries the title from page load, not from the press'
  );
  assert.ok(
    body.includes(preserve.REVISED_NOTE),
    'the comment states the provenance from page load, not from the press'
  );
  assert.ok(!body.includes(TITLE), 'the comment carries the title the panel loaded with');
  preserve.attempts.clear();
});

test('a press on an advisory another tab preserved writes nothing', async () => {
  preserve.attempts.clear();
  const fake = exchange({ page: pageHtml({ preserved: true }) });
  const outcome = await preserve.preserve(advisory, run(fake));
  assert.ok(outcome.ok === false, 'a second comment was written onto a preserved advisory');
  assert.strictEqual(outcome.reason, 'preserved');
  assert.strictEqual(fake.posts().length, 0, 'a second comment was posted');
  assert.strictEqual(preserve.offered(advisory).reason, 'preserved');
  preserve.attempts.clear();
});

test('a press whose page could not be read writes nothing and can be pressed again', async () => {
  preserve.attempts.clear();
  const fake = exchange({ pageStatus: 503 });
  const outcome = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'fetch');
  assert.strictEqual(outcome.status, 503);
  assert.strictEqual(fake.posts().length, 0);
  assert.strictEqual(preserve.attempts.size, 0);
  assert.strictEqual(preserve.offered(advisory).writable, true);
});

test('a second press while the first is still in flight sends nothing', async () => {
  preserve.attempts.clear();
  /** @type {() => void} */
  let release = () => {};
  /** @type {Promise<void>} */
  const holdWrite = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const fake = exchange({ holdWrite });

  const first = preserve.preserve(advisory, run(fake));
  await tick();
  assert.strictEqual(fake.posts().length, 1, 'the first press had not reached the write');

  const state = preserve.offered(advisory);
  assert.ok(state.available === false, 'the button is offered while a press is in flight');
  assert.strictEqual(state.reason, 'attempted');

  const second = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'attempted');
  assert.strictEqual(fake.posts().length, 1, 'a second comment was posted');

  release();
  const outcome = await first;
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(fake.posts().length, 1, 'a second comment was posted');
  preserve.attempts.clear();
});

test('a second press while the first is still reading the page sends nothing', async () => {
  preserve.attempts.clear();
  /** @type {() => void} */
  let release = () => {};
  /** @type {Promise<void>} */
  const holdPage = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const fake = exchange({ holdPage });

  const first = preserve.preserve(advisory, run(fake));
  await tick();
  assert.strictEqual(fake.calls.length, 1, 'the first press had not reached the page');

  const state = preserve.offered(advisory);
  assert.ok(state.available === false, 'the button is offered while a press is in flight');
  assert.strictEqual(state.reason, 'pending');
  assert.strictEqual(state.message, preserve.PENDING_MESSAGE);

  const second = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(second.reason, 'pending');
  assert.strictEqual(fake.calls.length, 1, 'a second press went out');

  release();
  const outcome = await first;
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(fake.posts().length, 1, 'a second comment was posted');
  preserve.attempts.clear();
});

test('an advisory whose own description quotes the summary is not confirmation', async () => {
  preserve.attempts.clear();
  const quoted =
    '<!doctype html><html><body><div class="comment-body markdown-body js-comment-body">' +
    `<p>${preserve.PRESERVE_SUMMARY}</p></div></body></html>`;
  const fake = exchange({ answer: quoted });
  const outcome = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unwritten');
  preserve.attempts.clear();
});

test('a second press in one page lifetime is not offered', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  const first = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(first.ok, true);

  const state = preserve.offered(advisory);
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.reason, 'preserved');
  assert.strictEqual(state.message, 'The original report is preserved.');

  const second = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'preserved');
  assert.strictEqual(fake.posts().length, 1);
  preserve.attempts.clear();
});

test('a press whose answer did not confirm it is not offered again', async () => {
  preserve.attempts.clear();
  const fake = exchange({ answer: '<!doctype html><html><body>nothing</body></html>' });
  const first = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(first.reason, 'unwritten');

  const state = preserve.offered(advisory);
  assert.ok(state.available === false, 'the button is offered while a press is in flight');
  assert.strictEqual(state.reason, 'attempted');
  assert.strictEqual(state.message, preserve.ATTEMPTED_MESSAGE);
  assert.strictEqual(
    state.message,
    'A press has already gone to GitHub for this advisory. Reload the page to see whether the comment was created.'
  );

  const second = await preserve.preserve(advisory, run(fake));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'attempted');
  assert.strictEqual(fake.posts().length, 1);
  preserve.attempts.clear();
});

test('a press that never went out leaves the button offered', async () => {
  preserve.attempts.clear();
  const fake = exchange();
  const refused = await preserve.preserve(
    { ...advisory, ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' } },
    run(fake)
  );
  assert.strictEqual(refused.reason, 'allowlist');
  assert.strictEqual(preserve.attempts.size, 0);
  assert.strictEqual(preserve.offered(advisory).available, true);
});

