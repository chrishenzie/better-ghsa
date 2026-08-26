'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const write = require('../src/common/write.js');

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

/** The advisory the fixtures come from, which is on the allowlist. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-jmvx-2wfw-xfgj' };

/** That advisory's repository, as the allowlist names it. */
const REPO = `${REF.owner}/${REF.repo}`;

/** The one parse of each large fixture in this file. */
const triageDoc = fixture('triage-thread.html');
const editDoc = fixture('edit-form.html');

/**
 * @param {Document} doc
 * @param {string} selector
 * @returns {Element} the one element `selector` names.
 */
function one(doc, selector) {
  const found = doc.querySelector(selector);
  if (found === null) throw new Error(`no element matching ${selector}`);
  return found;
}

/**
 * @param {URLSearchParams} params
 * @returns {string[]} the field names, in order, with repeats kept.
 */
function names(params) {
  return Array.from(params.keys());
}

/**
 * A stand-in for `fetch` that answers with what the test hands it and records
 * the one call it was given.
 *
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

/** A response document holding the comment that was written. */
const WROTE = '<!doctype html><html><body><div class="comment-body">' +
  '<details><summary>Original report preserved by Better GHSA</summary>' +
  '<p>Path traversal in drawer handler</p></details></div></body></html>';

/** A response document holding no such comment. */
const WROTE_NOTHING = '<!doctype html><html><body><div>Something went wrong.</div></body></html>';

/**
 * @param {Partial<import('../src/common/write.js').CreateCommentOptions>} overrides
 * @returns {import('../src/common/write.js').CreateCommentOptions}
 */
function options(overrides) {
  return {
    doc: triageDoc,
    ref: REF,
    body: 'a comment',
    contains: ['Original report preserved by Better GHSA'],
    parseDocument: document,
    ...overrides,
  };
}

test('the create form is the one whose action path ends in /comments', () => {
  const form = write.findCommentForm(triageDoc);
  assert.ok(form !== null, 'the triage thread carries no create-comment form');
  assert.strictEqual(
    /** @type {Element} */ (form).getAttribute('action'),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  assert.strictEqual(
    /** @type {Element} */ (form).getAttribute('class'),
    'js-advisory-comment-form'
  );
});

test('an edit form is not taken for the create form', () => {
  assert.ok(write.findCommentForm(editDoc) === null, 'an edit form was taken for the create form');
});

test('the clone of an edit form carries every field the server signed', () => {
  const params = write.cloneForm(one(editDoc, 'form#advisory-comment-282847-edit-form'));
  const carried = names(params);
  for (const field of [
    '_method',
    'authenticity_token',
    'context',
    'timestamp',
    'timestamp_secret',
    'repository_advisory_comment[id]',
    'repository_advisory_comment[bodyVersion]',
    'repository_advisory_comment[body]',
    'comment_id',
  ]) {
    assert.ok(carried.includes(field), `the clone dropped ${field}`);
  }
  const required = carried.filter((name) => name.startsWith('required_field_'));
  assert.strictEqual(required.length, 1);
  assert.strictEqual(required[0], 'required_field_9231');
  assert.strictEqual(params.get('_method'), 'put');
});

test('a disabled field, and a field inside a template, are not submitted', () => {
  const doc = document(
    '<!doctype html><html><body><form action="/o/r/security/advisories/G/comments">' +
      '<input type="hidden" name="kept" value="1">' +
      '<input type="hidden" name="off" value="1" disabled>' +
      '<template><input type="hidden" name="inert" value="1"></template>' +
      '<input type="checkbox" name="unchecked" value="y">' +
      '<input type="checkbox" name="checked" value="y" checked>' +
      '</form></body></html>'
  );
  const params = write.cloneForm(one(doc, 'form'));
  assert.deepStrictEqual(names(params), ['kept', 'checked']);
  assert.strictEqual(params.get('checked'), 'y');
});

test('what a page renders in a comment is what confirms a write', () => {
  assert.strictEqual(write.commentContains(triageDoc, ['Better GHSA tracking state']), true);
  assert.strictEqual(
    write.commentContains(triageDoc, ['Original report preserved by Better GHSA']),
    false
  );
  assert.strictEqual(write.commentContains(triageDoc, []), false);
});

test('a body echoed back into the comment box does not confirm a write', () => {
  const echoed = document(
    '<!doctype html><html><body>' +
      '<div class="comment-body markdown-body js-comment-body">' +
      '<form action="/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments">' +
      '<textarea name="body">Original report preserved by Better GHSA and both notes</textarea>' +
      '</form></div></body></html>'
  );
  assert.ok(
    write.commentContains(echoed, ['Original report preserved by Better GHSA']) === false,
    'a body echoed into the comment box confirmed a write'
  );
});

test('the strings a write put in one comment must come back in one comment', () => {
  const scattered = document(
    '<!doctype html><html><body>' +
      '<div class="comment-body">Original report preserved by Better GHSA</div>' +
      '<div class="comment-body">The title below is the advisory title.</div>' +
      '</body></html>'
  );
  const together = document(
    '<!doctype html><html><body><div class="comment-body">' +
      'Original report preserved by Better GHSA. The title below is the advisory title.' +
      '</div></body></html>'
  );
  const needles = [
    'Original report preserved by Better GHSA',
    'The title below is the advisory title.',
  ];
  assert.strictEqual(write.commentContains(scattered, needles), false);
  assert.strictEqual(write.commentContains(together, needles), true);
});

test('a form action names the advisory the reference names', () => {
  assert.strictEqual(
    write.commentPath(REF),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  for (const action of [
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    'https://github.com/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    '/GIT-UTENSILS/spoon-knife/security/advisories/GHSA-JMVX-2WFW-XFGJ/comments',
  ]) {
    assert.strictEqual(write.actionMatchesRef(action, REF), true, action);
  }
  for (const action of [
    '/someone/else/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-0000-0000-0000/comments',
    'https://example.invalid/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments',
    'comments',
    '',
  ]) {
    assert.strictEqual(write.actionMatchesRef(action, REF), false, action);
  }
});

test('a comment form posting to another advisory is not written to', async () => {
  const elsewhere = document(
    '<!doctype html><html><body>' +
      '<form action="/someone/else/security/advisories/GHSA-0000-0000-0000/comments">' +
      '<input type="hidden" name="authenticity_token" value="t">' +
      '<textarea name="body"></textarea></form></body></html>'
  );
  const fake = fakeFetch(200, WROTE);
  const outcome = await write.createComment(options({ doc: elsewhere, fetch: fake.send }));
  assert.ok(outcome.ok === false, 'the write went to a form naming another advisory');
  assert.strictEqual(outcome.reason, 'mismatch');
  assert.strictEqual(fake.calls.length, 0, 'a request went out');
  assert.strictEqual(
    outcome.message,
    'Nothing was written: the comment form on this page posts somewhere other than' +
      ' git-utensils/Spoon-Knife GHSA-jmvx-2wfw-xfgj.'
  );
});

test('the caller is told the request is going out before the answer is awaited', async () => {
  /** @type {string[]} */
  const order = [];
  const outcome = await write.createComment(
    options({
      beforeSend: () => order.push('held'),
      fetch: async () => {
        order.push('sent');
        return { status: 200, text: async () => WROTE };
      },
    })
  );
  assert.strictEqual(outcome.ok, true);
  assert.deepStrictEqual(order, ['held', 'sent']);
});

test('a write GitHub answered with the whole advisory page is confirmed', async () => {
  const answer = fs.readFileSync(
    path.join(__dirname, '..', 'testdata', 'triage-thread.html'),
    'utf8'
  );
  const fake = fakeFetch(200, answer);
  const outcome = await write.createComment(
    options({ contains: ['Better GHSA tracking state'], fetch: fake.send })
  );
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.status, 200);
});

test('a repository off the allowlist is refused before a request is built', async () => {
  const fake = fakeFetch(200, WROTE);
  const outcome = await write.createComment(
    options({
      ref: { owner: 'someone', repo: 'else', ghsaId: 'GHSA-0000-0000-0000' },
      fetch: fake.send,
    })
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'allowlist');
  assert.strictEqual(fake.calls.length, 0);
  assert.strictEqual(
    outcome.message,
    "Nothing was written: someone/else is not on this extension's allowlist."
  );
});

test('a write posts the cloned form, with the body replaced, to the form action', async () => {
  const fake = fakeFetch(200, WROTE);
  const outcome = await write.createComment(
    options({ body: 'the comment this extension writes', fetch: fake.send })
  );
  assert.strictEqual(outcome.ok, true);
  assert.strictEqual(outcome.reason, null);
  assert.strictEqual(outcome.status, 200);
  assert.strictEqual(fake.calls.length, 1);

  const call = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[0]);
  assert.strictEqual(
    call.url,
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  assert.strictEqual(call.init.method, 'POST');
  assert.strictEqual(call.init.credentials, 'same-origin');

  const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (call.init.body));
  assert.ok(sent instanceof URLSearchParams, 'the write did not send form parameters');
  assert.strictEqual(sent.get('body'), 'the comment this extension writes');
  assert.ok(sent.has('authenticity_token'), 'the write dropped the authenticity token');
  assert.strictEqual(sent.get('comment'), '1');
  assert.ok(!sent.has('comment_and_close'), 'the write carried the close action');
});

test('a non-2xx answer is a failed write', async () => {
  for (const status of [302, 403, 422, 500]) {
    const fake = fakeFetch(status, WROTE);
    const outcome = await write.createComment(options({ fetch: fake.send }));
    assert.strictEqual(outcome.ok, false, `status ${status}`);
    assert.strictEqual(outcome.reason, 'status', `status ${status}`);
    assert.strictEqual(outcome.status, status);
    assert.strictEqual(outcome.message, `The write failed: GitHub answered ${status}.`);
  }
});

test('a 2xx answer without the comment is a failed write', async () => {
  const fake = fakeFetch(200, WROTE_NOTHING);
  const outcome = await write.createComment(options({ fetch: fake.send }));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unwritten');
  assert.strictEqual(outcome.status, 200);
  assert.strictEqual(
    outcome.message,
    'The write could not be confirmed: GitHub answered without the comment.'
  );
});

test('a request that never arrived is a failed write', async () => {
  const outcome = await write.createComment(
    options({
      fetch: async () => {
        throw new TypeError('NetworkError');
      },
    })
  );
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unreachable');
  assert.strictEqual(outcome.status, null);
});

test('a page carrying no comment form is not written to', async () => {
  const fake = fakeFetch(200, WROTE);
  const outcome = await write.createComment(options({ doc: editDoc, fetch: fake.send }));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'no-form');
  assert.strictEqual(fake.calls.length, 0);
});

test('a write this extension could not confirm is not sent', async () => {
  const fake = fakeFetch(200, WROTE);
  const empty = await write.createComment(options({ body: '  ', fetch: fake.send }));
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'unverifiable');
  const blind = await write.createComment(options({ contains: [''], fetch: fake.send }));
  assert.strictEqual(blind.ok, false);
  assert.strictEqual(blind.reason, 'unverifiable');
  assert.strictEqual(fake.calls.length, 0);
});

