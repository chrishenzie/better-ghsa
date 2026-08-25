'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const parse = require('../src/common/parse-detail.js');
const derive = require('../src/common/derive.js');

/**
 * @param {string} name
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function advisory(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  const root = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const parsed = parse.parseDetail(root);
  if (parsed === null) throw new Error(`${name} is not an advisory detail page`);
  return parsed;
}

test('a Member comment makes the advisory reviewed', () => {
  const state = derive.derive(advisory('triage-thread.html'));
  assert.deepStrictEqual(state.members, ['samuelkarp']);
  assert.strictEqual(state.neverReviewed, false);
});

test('a member action after the last reporter comment clears new activity', () => {
  const state = derive.derive(advisory('triage-thread.html'));
  assert.strictEqual(state.lastNonMemberCommentAt, '2026-08-25T22:17:47Z');
  assert.strictEqual(state.lastMemberActivityAt, '2026-08-25T22:22:42Z');
  assert.strictEqual(state.newActivity, false);
});

test('a reporter comment newer than every member action is new activity', () => {
  const parsed = advisory('triage-thread.html');
  const trimmed = {
    ...parsed,
    timeline: parsed.timeline.filter((event) => event.actor !== 'samuelkarp'),
  };
  const state = derive.derive(trimmed);
  assert.strictEqual(state.lastMemberActivityAt, '2026-08-25T22:17:05Z');
  assert.strictEqual(state.newActivity, true);
});

test('an advisory with no comment at all has no visible member', () => {
  const state = derive.derive(advisory('published-containerd.html'));
  assert.deepStrictEqual(state.members, []);
  assert.strictEqual(state.neverReviewed, true);
  assert.strictEqual(state.newActivity, false);
});

test('a CVE named on the advisory reads as assigned', () => {
  const state = derive.derive(advisory('published-containerd.html'));
  assert.deepStrictEqual(state.cve, {
    id: 'CVE-2026-31984',
    assigned: true,
    requested: true,
    selection: 'existing',
    state: 'assigned',
  });
});

test('an advisory that has never asked for a CVE reads as none', () => {
  const state = derive.derive(advisory('triage-thread.html'));
  assert.deepStrictEqual(state.cve, {
    id: null,
    assigned: false,
    requested: false,
    selection: 'requesting',
    state: 'none',
  });
});

test('a fork with one pull request per branch reports both branches prepared', () => {
  const state = derive.derive(advisory('triage-thread.html'));
  assert.strictEqual(state.patch.hasFork, true);
  assert.deepStrictEqual(state.patch.open, [2, 1]);
  assert.deepStrictEqual(state.patch.merged, []);
  assert.deepStrictEqual(state.patch.closed, []);
  assert.deepStrictEqual(state.patch.branches, [
    { branch: 'release/1.0', pullRequests: [2], open: true },
    { branch: 'main', pullRequests: [1], open: true },
  ]);
});

test('an advisory with no private fork has no patch prepared', () => {
  const state = derive.derive(advisory('draft.html'));
  assert.strictEqual(state.patch.hasFork, false);
  assert.deepStrictEqual(state.patch.branches, []);
  assert.deepStrictEqual(state.patch.pullRequests, []);
});
