'use strict';

const test = require('node:test');
const assert = require('node:assert');

const content = require('../src/content.js');

test('a detail page yields owner, repository, and advisory', () => {
  assert.deepStrictEqual(
    content.locate('/containerd/containerd/security/advisories/GHSA-1234-5678-9abc'),
    { owner: 'containerd', repo: 'containerd', ghsaId: 'GHSA-1234-5678-9abc' }
  );
});

test('the list page yields no advisory', () => {
  assert.deepStrictEqual(content.locate('/containerd/containerd/security/advisories'), {
    owner: 'containerd',
    repo: 'containerd',
    ghsaId: null,
  });
});

test('paths that are not advisory pages yield null', () => {
  assert.strictEqual(content.locate('/containerd/containerd'), null);
  assert.strictEqual(content.locate('/containerd/containerd/security/policy'), null);
  assert.strictEqual(content.locate('/'), null);
});
