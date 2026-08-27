'use strict';

const test = require('node:test');
const assert = require('node:assert');

const record = require('../src/common/record.js');

test('a cache record this reader cannot use answers as absent', () => {
  assert.ok(record.advisoryFrom(null) === null, 'null is not an advisory');
  assert.ok(record.advisoryFrom('advisory') === null, 'a string is not an advisory');
  assert.ok(record.advisoryFrom({ ghsaId: 'GHSA-x' }) === null, 'a record with no comment list');
  assert.ok(record.advisoryFrom({ comments: [], timeline: {} }) === null, 'a record with no timeline');
});

test("an author's standing in a cache record is recomputed, not read", () => {
  const advisory = record.advisoryFrom({
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

test('a cache record carries the advisory the parser read', () => {
  const advisory = record.advisoryFrom({
    ghsaId: 'GHSA-jmvx-2wfw-xfgj',
    state: 'Closed',
    severity: 'high',
    reportedAt: '2026-08-25T22:15:18Z',
    reporter: 'prakleumas',
    comments: [],
    timeline: [{ id: 'event-1', actor: 'samuelkarp', at: '2026-08-26T00:00:00Z', text: 'samuelkarp accepted this report' }],
    fork: { pullRequests: [{ number: 7, state: 'open', baseRef: 'main' }] },
    collaborators: ['prakleumas', 42],
  });
  if (advisory === null) throw new Error('the record did not read as an advisory');
  assert.strictEqual(advisory.ghsaId, 'GHSA-jmvx-2wfw-xfgj');
  assert.strictEqual(advisory.state, 'Closed');
  assert.strictEqual(advisory.severity, 'high');
  assert.strictEqual(advisory.reportedAt, '2026-08-25T22:15:18Z');
  assert.strictEqual(advisory.reporter, 'prakleumas');
  assert.strictEqual(advisory.timeline.length, 1);
  assert.strictEqual(advisory.timeline[0]?.text, 'samuelkarp accepted this report');
  assert.strictEqual(advisory.fork?.pullRequests[0]?.number, 7);
  assert.strictEqual(advisory.fork?.pullRequests[0]?.baseRef, 'main');
  assert.deepStrictEqual(advisory.collaborators, ['prakleumas']);
});
