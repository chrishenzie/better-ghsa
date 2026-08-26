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
const triageDoc = fixture('triage-thread.html');
const triage = /** @type {import('../src/common/parse-detail.js').ParsedDetail} */ (
  parse.parseDetail(triageDoc)
);
const draft = record('draft.html');

/**
 * An advisory holding just the values the comment states, so the body it
 * renders can be compared whole.
 *
 * @param {boolean | null} original
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function sample(original) {
  return {
    ...triage,
    title: 'Path traversal in the drawer handler',
    description: '### Summary\n\nThe handler joins a path without normalizing it.',
    descriptionOriginal: original,
    comments: [],
  };
}

/** The comment an advisory whose description has never been revised gets. */
const ORIGINAL_BODY = [
  '<details>',
  '<summary>Original report preserved by Better GHSA</summary>',
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
  '---',
  '',
  'The title above is the advisory title as it stood when this comment was written,' +
    ' because GitHub records no revision signal for a title.',
  '',
  "The description above is the reporter's original text: the advisory description" +
    ' carried no revision when this comment was written.',
  '',
  '</details>',
  '',
].join('\n');

/** The comment an advisory whose description has been revised gets. */
const REVISED_BODY = ORIGINAL_BODY.replace(
  "The description above is the reporter's original text: the advisory description" +
    ' carried no revision when this comment was written.',
  'The description above is the text as it stood when this comment was written.' +
    ' The advisory description has been revised since it was reported.'
);

/**
 * @param {number} status
 * @param {string} body
 * @returns {{ send: import('../src/common/write.js').WriteFetch, calls: Array<{ url: string, init: RequestInit }> }}
 */
function fakeFetch(status, body) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  return {
    calls,
    send: async (url, init) => {
      calls.push({ url, init });
      return { status, text: async () => body };
    },
  };
}

/** A response holding the comment the write claims to have made. */
const WROTE =
  '<!doctype html><html><body><div class="comment-body"><details>' +
  '<summary>Original report preserved by Better GHSA</summary></details></div></body></html>';

test('a description that has never been revised is recorded as the original', () => {
  const body = preserve.buildBody(sample(true));
  assert.ok(body === ORIGINAL_BODY, `the comment body reads:\n${String(body)}`);
});

test('a description that has been revised is recorded as the text of the moment', () => {
  const body = preserve.buildBody(sample(false));
  assert.ok(body === REVISED_BODY, `the comment body reads:\n${String(body)}`);
});

test('the comment is one collapsed block carrying the fixed summary', () => {
  const body = /** @type {string} */ (preserve.buildBody(sample(true)));
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
  assert.strictEqual(preserve.buildBody(sample(null)), null);
  assert.strictEqual(preserve.buildBody({ ...sample(true), title: null }), null);
  assert.strictEqual(preserve.buildBody({ ...sample(true), description: null }), null);
});

test('an advisory with no preservation comment offers the button', () => {
  const state = preserve.offered(triage);
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.writable, true);
  assert.strictEqual(state.reason, null);
  assert.strictEqual(state.message, 'Preserve the title and description in a comment.');
});

test('the fixed summary text on a comment is what says the report is preserved', () => {
  const preserved = {
    ...triage,
    comments: [
      ...triage.comments,
      {
        ...(/** @type {import('../src/common/parse-detail.js').ParsedComment} */ (
          triage.comments[0]
        )),
        text: `Original report preserved by Better GHSA Title ${String(triage.title)}`,
      },
    ],
  };
  assert.strictEqual(preserve.hasPreservationComment(triage.comments), false);
  assert.strictEqual(preserve.hasPreservationComment(preserved.comments), true);

  const state = preserve.offered(preserved);
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'preserved');
  assert.strictEqual(state.message, 'The original report is already preserved.');
});

test('an advisory in a repository off the allowlist offers a button that refuses', () => {
  const elsewhere = {
    ...triage,
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
  const state = preserve.offered({ ...triage, descriptionOriginal: null });
  assert.strictEqual(state.available, true);
  assert.strictEqual(state.writable, false);
  assert.strictEqual(state.reason, 'provenance');
  assert.strictEqual(
    state.message,
    "Nothing was written: this extension could not tell whether the description is the reporter's original text."
  );
});

test('a title or description that did not read refuses the write', () => {
  for (const advisory of [
    { ...triage, title: null },
    { ...triage, description: null },
  ]) {
    const state = preserve.offered(advisory);
    assert.strictEqual(state.writable, false);
    assert.strictEqual(state.reason, 'unreadable');
  }
});

test('pressing on an advisory whose provenance did not read sends nothing', async () => {
  const fake = fakeFetch(200, WROTE);
  const outcome = await preserve.preserve(
    { ...triage, descriptionOriginal: null },
    { doc: triageDoc, fetch: fake.send, parseDocument: document }
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'provenance');
  assert.strictEqual(fake.calls.length, 0);
});

test('a press posts the comment to the advisory and confirms it in the answer', async () => {
  preserve.attempts.clear();
  const fake = fakeFetch(200, WROTE);
  const outcome = await preserve.preserve(triage, {
    doc: triageDoc,
    fetch: fake.send,
    parseDocument: document,
  });
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.status, 200);
  assert.strictEqual(fake.calls.length, 1);

  const call = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[0]);
  assert.strictEqual(
    call.url,
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (call.init.body));
  assert.ok(
    sent.get('body') === preserve.buildBody(triage),
    'the comment sent is not the comment that was built'
  );
});

test('a second press in one page lifetime is not offered', async () => {
  preserve.attempts.clear();
  const fake = fakeFetch(200, WROTE);
  const first = await preserve.preserve(triage, {
    doc: triageDoc,
    fetch: fake.send,
    parseDocument: document,
  });
  assert.strictEqual(first.ok, true);

  const state = preserve.offered(triage);
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.reason, 'preserved');
  assert.strictEqual(state.message, 'The original report is preserved.');

  const second = await preserve.preserve(triage, {
    doc: triageDoc,
    fetch: fake.send,
    parseDocument: document,
  });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'preserved');
  assert.strictEqual(fake.calls.length, 1);
  preserve.attempts.clear();
});

test('a press whose answer did not confirm it is not offered again', async () => {
  preserve.attempts.clear();
  const fake = fakeFetch(200, '<!doctype html><html><body>nothing</body></html>');
  const first = await preserve.preserve(triage, {
    doc: triageDoc,
    fetch: fake.send,
    parseDocument: document,
  });
  assert.strictEqual(first.reason, 'unwritten');

  const state = preserve.offered(triage);
  assert.strictEqual(state.available, false);
  assert.strictEqual(state.reason, 'attempted');
  assert.strictEqual(
    state.message,
    'A press has already gone to GitHub for this advisory. Reload the page to see whether the comment was created.'
  );

  const second = await preserve.preserve(triage, {
    doc: triageDoc,
    fetch: fake.send,
    parseDocument: document,
  });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'attempted');
  assert.strictEqual(fake.calls.length, 1);
  preserve.attempts.clear();
});

test('a press that never went out leaves the button offered', async () => {
  preserve.attempts.clear();
  const fake = fakeFetch(200, WROTE);
  const refused = await preserve.preserve(
    { ...triage, ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' } },
    { doc: triageDoc, fetch: fake.send, parseDocument: document }
  );
  assert.strictEqual(refused.reason, 'allowlist');
  assert.strictEqual(preserve.attempts.size, 0);
  assert.strictEqual(preserve.offered(triage).available, true);
});

