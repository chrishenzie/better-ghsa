'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const schema = require('../src/common/schema.js');
const write = require('../src/common/write.js');
const state = require('../src/detail/state.js');

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

/** The advisory the triage fixture holds, which is on the allowlist. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-jmvx-2wfw-xfgj' };

/** The advisory the draft fixture holds. */
const DRAFT_REF = { owner: 'git-utensils', repo: 'Spoon-Knife', ghsaId: 'GHSA-5hg2-rfq2-8fm5' };

/** The highest ordering claim the triage fixture carries. */
const OBSERVED = 7;

/** The write time every test stamps, so the snapshot it expects is exact. */
const AT = '2026-08-26T11:00:00Z';

/** The comment the signed-in maintainer wrote the triage fixture's state in. */
const OWN_ID = '282847';

/** The comment the reporter wrote their own state comment in. */
const OTHER_ID = '282848';

/** What the fetch stand-in answers the page request with. */
const PAGE_HTML = '<<the advisory page>>';

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The comment GitHub renders from a state comment body: the marker in a code
 * span, and the fence as a highlighted `pre` whose text reconstitutes the JSON.
 *
 * @param {string} markdown
 * @returns {string}
 */
function renderStateComment(markdown) {
  const marker = /`([^`\n]+)`/.exec(markdown)?.[1] ?? '';
  const fence = /```json\n([\s\S]*?)\n```/.exec(markdown)?.[1] ?? '';
  return (
    '<!doctype html><html><body>' +
    '<div class="comment-body markdown-body js-comment-body"><details>' +
    `<summary>${escapeHtml(schema.STATE_COMMENT_SUMMARY)}</summary>` +
    `<p><code>${escapeHtml(marker)}</code></p>` +
    `<div class="highlight highlight-source-json"><pre>${escapeHtml(fence)}</pre></div>` +
    '</details></div></body></html>'
  );
}

/**
 * @param {URLSearchParams} params
 * @returns {string} the comment body the request carries, whichever field it
 *   travels in.
 */
function postedBody(params) {
  return params.get('body') ?? params.get(write.EDIT_BODY_FIELD) ?? '';
}

/**
 * @typedef {(params: URLSearchParams) => { status: number, html: string }} Answer
 */

/** GitHub answering with the comment the request wrote. @type {Answer} */
const echo = (params) => ({ status: 200, html: renderStateComment(postedBody(params)) });

/**
 * A stand-in for `fetch` that hands the page request one document and the
 * comment request to `answer`.
 *
 * @param {Document} page
 * @param {Answer} [answer]
 * @returns {{
 *   fetch: import('../src/common/write.js').WriteFetch,
 *   parseDocument: (html: string) => Document,
 *   calls: Array<{ url: string, init: RequestInit }>,
 * }}
 */
function session(page, answer) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  const reply = answer ?? echo;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if ((init.method ?? 'GET') === 'GET') return { status: 200, text: async () => PAGE_HTML };
      const written = reply(/** @type {URLSearchParams} */ (/** @type {unknown} */ (init.body)));
      return { status: written.status, text: async () => written.html };
    },
    parseDocument: (html) => (html === PAGE_HTML ? page : document(html)),
  };
}

/**
 * @param {Document} page
 * @param {Partial<import('../src/detail/state.js').StateWriteOptions>} overrides
 * @param {Answer} [answer]
 * @returns {Promise<{
 *   outcome: import('../src/detail/state.js').StateWriteResult,
 *   calls: Array<{ url: string, init: RequestInit }>,
 * }>}
 */
async function run(page, overrides, answer) {
  const talk = session(page, answer);
  const outcome = await state.writeState({
    ref: REF,
    loadedSeq: OBSERVED,
    changes: {},
    at: AT,
    fetch: talk.fetch,
    parseDocument: talk.parseDocument,
    ...overrides,
  });
  return { outcome, calls: talk.calls };
}

/**
 * @param {Array<{ url: string, init: RequestInit }>} calls
 * @returns {URLSearchParams} the parameters the comment request carried.
 */
function sent(calls) {
  const post = calls.find((call) => call.init.method === 'POST');
  if (post === undefined) throw new Error('no comment request went out');
  return /** @type {URLSearchParams} */ (/** @type {unknown} */ (post.init.body));
}

/**
 * @param {Array<{ url: string, init: RequestInit }>} calls
 * @returns {string} the URL the comment request went to.
 */
function target(calls) {
  const post = calls.find((call) => call.init.method === 'POST');
  if (post === undefined) throw new Error('no comment request went out');
  return post.url;
}

/** @returns {Document} the triage advisory, parsed for one test to change. */
function triagePage() {
  return fixture('triage-thread.html');
}

/**
 * @param {Document} page
 * @param {string} login The account the page is to read as signed in.
 * @returns {void}
 */
function signIn(page, login) {
  const link = page.querySelector('div.timeline-new-comment span.timeline-comment-avatar a');
  if (link === null) throw new Error('the page carries no new-comment box');
  link.setAttribute('href', `/${login}`);
  const image = link.querySelector('img[alt]');
  if (image !== null) image.setAttribute('alt', `@${login}`);
}

test('a write edits the state comment the signed-in maintainer wrote', async () => {
  const { outcome, calls } = await run(triagePage(), {
    changes: { triage: 'evaluating' },
  });
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(
    target(calls),
    `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${OWN_ID}`
  );
  assert.ok(
    !target(calls).endsWith(`/comments/${OTHER_ID}`),
    "the write targeted the other maintainer's comment"
  );
  const params = sent(calls);
  assert.ok(params.has(write.EDIT_BODY_FIELD), 'the edit carried no body field');
  assert.ok(
    params.has('repository_advisory_comment[bodyVersion]'),
    'the edit carried no concurrency token'
  );

  const snapshot = /** @type {Record<string, unknown>} */ (outcome.snapshot);
  assert.ok(snapshot.seq === 8, `the snapshot claimed sequence ${String(snapshot.seq)}`);
  assert.ok(snapshot.by === 'samuelkarp', `the snapshot was written by ${String(snapshot.by)}`);
  assert.ok(snapshot.at === AT, 'the snapshot carries another write time');
  assert.ok(snapshot.betterGhsa === '1.0', 'the snapshot carries another schema version');
  assert.ok(snapshot.triage === 'evaluating', 'the change did not reach the snapshot');
});

test('a field this reader does not know survives the write', async () => {
  const { outcome, calls } = await run(triagePage(), { changes: { triage: 'evaluating' } });
  assert.strictEqual(outcome.ok, true);
  const carried = /** @type {Record<string, unknown>} */ (
    /** @type {Record<string, unknown>} */ (outcome.snapshot).cutleryPolicy
  );
  assert.ok(carried !== undefined, 'the unknown field was dropped');
  assert.ok(carried.sharpened === true, 'the unknown field lost its value');
  assert.ok(
    postedBody(sent(calls)).includes('"cutleryPolicy"'),
    'the request did not carry the unknown field'
  );
});

test('the sequence the write claims is one above the highest on the advisory', async () => {
  const { outcome } = await run(triagePage(), {});
  // The advisory's highest claim is the reporter's, whose snapshot this reader
  // does not count toward state. The next write still outranks it.
  assert.strictEqual(outcome.merged?.observedSeq, OBSERVED);
  assert.strictEqual(outcome.merged?.seq, 3);
  assert.ok(
    /** @type {Record<string, unknown>} */ (outcome.snapshot).seq === OBSERVED + 1,
    'the write did not outrank every claim on the advisory'
  );
});

test('the comment the write sends parses back as the snapshot it wrote', async () => {
  const { outcome, calls } = await run(triagePage(), { changes: { triage: 'evaluating' } });
  assert.strictEqual(outcome.ok, true);
  const rendered = document(renderStateComment(postedBody(sent(calls))));
  const report = parse.parseStateComment(rendered.querySelector('.comment-body'));
  assert.ok(report !== null, 'the comment this extension wrote is not a state comment');
  assert.ok(report.valid === true, `the snapshot did not validate: ${report.problems.join('; ')}`);
  assert.ok(report.seq === 8, 'the snapshot came back with another sequence number');
  assert.ok(report.by === 'samuelkarp', 'the snapshot came back under another login');
});

test('the first write on an advisory creates the comment', async () => {
  const page = triagePage();
  const own = page.querySelector(`#advisory-comment-${OWN_ID}`);
  if (own === null) throw new Error('the fixture carries no state comment to remove');
  own.remove();

  const { outcome, calls } = await run(page, {});
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.strictEqual(
    target(calls),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments'
  );
  const params = sent(calls);
  assert.ok(params.has('body'), 'the create carried no body field');
  assert.ok(params.has('authenticity_token'), 'the create carried no token');
  const snapshot = /** @type {Record<string, unknown>} */ (outcome.snapshot);
  assert.ok(snapshot.seq === 8, 'the created snapshot claimed another sequence');
  assert.ok(snapshot.by === 'samuelkarp', 'the created snapshot named another writer');
  assert.ok(snapshot.cutleryPolicy === undefined, 'a removed comment still reached state');
});

test('a write never targets the comment another maintainer wrote', async () => {
  const page = triagePage();
  // The same page, read from the reporter's session. The comment holding
  // current state is not theirs, and the write does not touch it.
  signIn(page, 'prakleumas');
  const { outcome, calls } = await run(page, {});
  assert.ok(outcome.ok === true, `the write failed: ${outcome.message}`);
  assert.strictEqual(
    target(calls),
    `/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj/comments/${OTHER_ID}`
  );
  assert.ok(
    /** @type {Record<string, unknown>} */ (outcome.snapshot).by === 'prakleumas',
    'the snapshot was stamped with another login'
  );
});

test('a maintainer with two state comments is not written for', async () => {
  const page = triagePage();
  const other = page.querySelector(`#advisory-comment-${OTHER_ID}`);
  if (other === null) throw new Error('the fixture carries one state comment');
  for (const link of other.querySelectorAll('a.author')) link.setAttribute('href', '/samuelkarp');

  const { outcome, calls } = await run(page, {});
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'ambiguous');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
});

test('a page that moved past the sequence the panel loaded refuses the write', async () => {
  for (const loadedSeq of [3, 6, 8]) {
    const { outcome, calls } = await run(triagePage(), { loadedSeq });
    assert.strictEqual(outcome.ok, false, `sequence ${loadedSeq}`);
    assert.strictEqual(outcome.reason, 'stale', `sequence ${loadedSeq}`);
    assert.strictEqual(calls.length, 1, 'a comment request went out');
    assert.strictEqual(outcome.snapshot, null);
    // The panel reloads from what the page says now.
    assert.strictEqual(outcome.merged?.observedSeq, OBSERVED);
    assert.strictEqual(
      outcome.message,
      `Nothing was written: this advisory is at sequence ${OBSERVED} and the panel was` +
        ` loaded at ${loadedSeq}. Reload and apply the change again.`
    );
  }
});

test('a page naming no signed-in account is not written to', async () => {
  const page = triagePage();
  const box = page.querySelector('div.timeline-new-comment');
  if (box === null) throw new Error('the fixture carries no new-comment box');
  box.remove();
  const { outcome, calls } = await run(page, {});
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'unreadable');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
});

test('a snapshot this extension could not interpret takes one confirmation', async () => {
  const page = fixture('draft.html');
  const refusal = await run(page, { ref: DRAFT_REF, loadedSeq: 2 });
  assert.strictEqual(refusal.outcome.ok, false);
  assert.strictEqual(refusal.outcome.reason, 'confirmation');
  assert.strictEqual(refusal.calls.length, 1, 'a comment request went out');
  assert.strictEqual(refusal.outcome.merged?.confirmationRequired, true);

  const confirmed = await run(page, { ref: DRAFT_REF, loadedSeq: 2, confirmed: true });
  assert.ok(confirmed.outcome.ok === true, `the write failed: ${confirmed.outcome.message}`);
  assert.strictEqual(
    target(confirmed.calls),
    '/git-utensils/Spoon-Knife/security/advisories/GHSA-5hg2-rfq2-8fm5/comments/282849'
  );
  assert.ok(
    /** @type {Record<string, unknown>} */ (confirmed.outcome.snapshot).seq === 3,
    'the confirmed write did not outrank the snapshot it supersedes'
  );
});

test('a schema major this extension does not read refuses the write', async () => {
  const page = fixture('draft.html');
  const fence = page.querySelector('.highlight-source-json pre');
  if (fence === null) throw new Error('the draft fixture carries no snapshot');
  fence.textContent = '{ "betterGhsa": "2.0", "seq": 2, "by": "samuelkarp" }';

  const { outcome, calls } = await run(page, { ref: DRAFT_REF, loadedSeq: 2, confirmed: true });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.reason, 'read-only');
  assert.strictEqual(calls.length, 1, 'a comment request went out');
  assert.strictEqual(outcome.merged?.readOnly, true);
});

test('triageSince marks the moment the triage value last changed', async () => {
  const carried = await run(triagePage(), { changes: { owners: ['dmcgowan'] } });
  assert.strictEqual(carried.outcome.ok, true);
  assert.ok(
    /** @type {Record<string, unknown>} */ (carried.outcome.snapshot).triageSince ===
      '2026-08-25T18:04:11Z',
    'a write that left triage alone moved triageSince'
  );

  const changed = await run(triagePage(), { changes: { triage: 'evaluating' } });
  assert.strictEqual(changed.outcome.ok, true);
  assert.ok(
    /** @type {Record<string, unknown>} */ (changed.outcome.snapshot).triageSince === AT,
    'a write that changed triage did not move triageSince'
  );
});

