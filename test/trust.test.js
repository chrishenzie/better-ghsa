'use strict';

const test = require('node:test');
const assert = require('node:assert');

const trust = require('../src/common/trust.js');

test('Member and Owner snapshots count', () => {
  assert.strictEqual(trust.isTrustedAuthor('samuelkarp', 'Member'), true);
  assert.strictEqual(trust.isTrustedAuthor('dmcgowan', 'Owner'), true);
});

test('every other badge is refused', () => {
  assert.strictEqual(trust.isTrustedAuthor('prakleumas', 'Author'), false);
  assert.strictEqual(trust.isTrustedAuthor('prakleumas', 'Contributor'), false);
  assert.strictEqual(trust.isTrustedAuthor('prakleumas', ''), false);
  assert.strictEqual(trust.isTrustedAuthor('prakleumas', null), false);
});

test('a snapshot with no identifiable author is refused', () => {
  assert.strictEqual(trust.isTrustedAuthor(null, 'Member'), false);
  assert.strictEqual(trust.isTrustedAuthor('', 'Member'), false);
  assert.strictEqual(trust.isTrustedAuthor('   ', 'Member'), false);
});

test('badge text is compared without regard to case or surrounding space', () => {
  assert.strictEqual(trust.isTrustedAuthor('samuelkarp', ' member '), true);
  assert.strictEqual(trust.isTrustedAuthor('samuelkarp', 'OWNER'), true);
});
