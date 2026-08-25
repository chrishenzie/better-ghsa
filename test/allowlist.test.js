'use strict';

const test = require('node:test');
const assert = require('node:assert');

const allowlist = require('../src/common/allowlist.js');

test('the seeded repositories are allowed', () => {
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), true);
  assert.strictEqual(allowlist.isAllowed('git-utensils/Spoon-Knife'), true);
});

test('owner and repository names compare case-insensitively', () => {
  assert.strictEqual(allowlist.isAllowed('Containerd/ContainerD'), true);
  assert.strictEqual(allowlist.isAllowed('git-utensils/spoon-knife'), true);
});

test('a repository off the list is refused', () => {
  assert.strictEqual(allowlist.isAllowed('containerd/nerdctl'), false);
  assert.strictEqual(allowlist.isAllowed(''), false);
  assert.strictEqual(allowlist.isAllowed('containerd'), false);
});

test('the same members are reachable through globalThis.bghsa', () => {
  assert.strictEqual(globalThis.bghsa.allowlist.isAllowed, allowlist.isAllowed);
  assert.strictEqual(globalThis.bghsa.allowlist.ALLOWLIST, allowlist.ALLOWLIST);
  assert.strictEqual(globalThis.bghsa.allowlist.isAllowed('containerd/containerd'), true);
});
