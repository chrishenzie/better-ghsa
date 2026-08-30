'use strict';

const test = require('node:test');
const assert = require('node:assert');

const allowlist = require('../src/common/allowlist.js');
const branches = require('../src/common/branches.js');
const cache = require('../src/common/cache.js');
const members = require('../src/common/members.js');
const forget = require('../src/common/forget.js');

// A stand-in for `browser.storage.local`. Its `get(null)` answers with
// everything, which is what the real one does and what the clear reads.
const { fakeStorage } = require('../test-support/storage.js');

/** Two repositories in one organization, and one in another. */
const CONTAINERD = 'containerd/containerd';
const NERDCTL = 'containerd/nerdctl';
const SPOON = 'git-utensils/spoon-knife';

/**
 * A repository whose whole name is a prefix of another repository's in the same
 * organization. `containerd/con` and `containerd/containerd` are what a key
 * matched on `adv:{owner}/{repo}` without its trailing colon would confuse.
 */
const CON = 'containerd/con';

/**
 * The keys one repository's reads are held under.
 *
 * @param {string} repository
 * @returns {string[]}
 */
function keysOf(repository) {
  return [
    `${cache.ADVISORY_PREFIX}${repository}:ghsa-1111-2222-3333`,
    `${cache.ADVISORY_PREFIX}${repository}:ghsa-4444-5555-6666`,
    `${cache.LIST_PREFIX}${repository}`,
    `${cache.PROGRESS_PREFIX}${repository}`,
  ];
}

/**
 * Storage as a browser that has read every one of these repositories holds it.
 *
 * @param {readonly string[]} repositories
 * @returns {ReturnType<typeof fakeStorage>}
 */
function stored(repositories) {
  /** @type {Record<string, unknown>} */
  const held = { [allowlist.STORAGE_KEY]: [...repositories] };
  /** @type {Record<string, string[]>} */
  const branchesHeld = {};
  /** @type {Record<string, string[]>} */
  const membersHeld = {};
  for (const repository of repositories) {
    for (const key of keysOf(repository)) {
      held[key] = { record: { state: 'triage' }, observedAt: 1, state: 'triage' };
    }
    branchesHeld[repository] = ['release/1.7', 'release/2.1'];
    membersHeld[String(repository.split('/')[0])] = ['samuelkarp'];
  }
  held[branches.BRANCHES_KEY] = branchesHeld;
  held[members.MEMBERS_KEY] = membersHeld;
  return fakeStorage(held);
}

/**
 * @param {ReturnType<typeof fakeStorage>} storage
 * @param {string} repository
 * @returns {string[]} the keys storage still holds for that repository.
 */
function survivors(storage, repository) {
  return keysOf(repository).filter((key) => Object.hasOwn(storage.entries, key));
}

/**
 * @param {ReturnType<typeof fakeStorage>} storage
 * @param {string} key
 * @returns {string[]} the names the map at that key still carries.
 */
function namesIn(storage, key) {
  const held = storage.entries[key];
  return held === undefined || held === null ? [] : Object.keys(held).sort();
}

test.afterEach(() => {
  cache.setStorage(null);
  allowlist.setStorage(null);
});

test('the clear empties every store and leaves the repository list', async () => {
  const storage = stored([CONTAINERD, NERDCTL, SPOON]);
  const outcome = await forget.everything({ storage });

  // Three repositories, four cache keys each, plus `members` and `branches`.
  assert.strictEqual(outcome.taken, 14, 'the clear took the wrong number of keys');
  assert.strictEqual(outcome.members, true);
  assert.strictEqual(outcome.branches, true);
  for (const repository of [CONTAINERD, NERDCTL, SPOON]) {
    assert.deepStrictEqual(survivors(storage, repository), [], `${repository} survived the clear`);
  }
  assert.strictEqual(Object.hasOwn(storage.entries, members.MEMBERS_KEY), false);
  assert.strictEqual(Object.hasOwn(storage.entries, branches.BRANCHES_KEY), false);
  // The list is the one thing the clear leaves: taking it would turn the
  // extension off. REQUIREMENTS.md section 2.
  assert.deepStrictEqual(storage.entries[allowlist.STORAGE_KEY], [CONTAINERD, NERDCTL, SPOON]);
  assert.deepStrictEqual(Object.keys(storage.entries), [allowlist.STORAGE_KEY]);
});

test('the clear on an empty store takes nothing and fails at nothing', async () => {
  const storage = fakeStorage({ [allowlist.STORAGE_KEY]: [CONTAINERD] });
  const outcome = await forget.everything({ storage });

  assert.deepStrictEqual(outcome, { taken: 0, branches: false, members: false });
  assert.deepStrictEqual(storage.entries[allowlist.STORAGE_KEY], [CONTAINERD]);
});

test('the clear reaches the storage the cache names when none is handed in', async () => {
  const storage = stored([CONTAINERD]);
  cache.setStorage(storage);

  const outcome = await forget.everything();

  assert.strictEqual(outcome.taken, 6, 'the clear took the wrong number of keys');
  assert.deepStrictEqual(Object.keys(storage.entries), [allowlist.STORAGE_KEY]);
});

test('unlisting clears that repository and leaves a sibling in the same organization', async () => {
  const storage = stored([CONTAINERD, NERDCTL, SPOON]);

  const outcome = await forget.repository(CONTAINERD, [NERDCTL, SPOON], { storage });

  assert.strictEqual(outcome.taken, 4, 'the wrong number of keys was taken');
  assert.deepStrictEqual(survivors(storage, CONTAINERD), []);
  // A fixture with one repository would pass here whether the code took that
  // repository's keys or every key in the store.
  assert.deepStrictEqual(survivors(storage, NERDCTL), keysOf(NERDCTL));
  assert.deepStrictEqual(survivors(storage, SPOON), keysOf(SPOON));
  assert.strictEqual(outcome.branches, true);
  assert.deepStrictEqual(namesIn(storage, branches.BRANCHES_KEY), [NERDCTL, SPOON].sort());
  // `containerd/nerdctl` is still listed, so the organization's members stay.
  assert.strictEqual(outcome.members, false);
  assert.deepStrictEqual(namesIn(storage, members.MEMBERS_KEY), ['containerd', 'git-utensils']);
});

test('unlisting takes the keys of a repository named the way a maintainer typed it', async () => {
  // Storage keys spell a repository the way the allowlist stores it, lowercased
  // and trimmed, while the name reaching here is the one that was typed. A
  // fixture whose name is already in that spelling would pass whether the name
  // was normalized or used as it stands.
  const storage = stored([CONTAINERD, NERDCTL]);

  const outcome = await forget.repository('  Containerd/Containerd  ', [' Containerd/NerdCTL '], {
    storage,
  });

  assert.strictEqual(outcome.taken, 4, 'the wrong number of keys was taken');
  assert.deepStrictEqual(survivors(storage, CONTAINERD), []);
  assert.deepStrictEqual(survivors(storage, NERDCTL), keysOf(NERDCTL));
  assert.strictEqual(outcome.branches, true);
  assert.deepStrictEqual(namesIn(storage, branches.BRANCHES_KEY), [NERDCTL]);
  // The sibling is still listed under a name in another spelling, so the
  // organization's members stay.
  assert.strictEqual(outcome.members, false);
  assert.deepStrictEqual(namesIn(storage, members.MEMBERS_KEY), ['containerd']);
});

test('unlisting the last repository of an organization clears its members', async () => {
  const storage = stored([CONTAINERD, NERDCTL, SPOON]);

  await forget.repository(CONTAINERD, [NERDCTL, SPOON], { storage });
  const outcome = await forget.repository(NERDCTL, [SPOON], { storage });

  assert.strictEqual(outcome.members, true);
  assert.deepStrictEqual(namesIn(storage, members.MEMBERS_KEY), ['git-utensils']);
  assert.deepStrictEqual(namesIn(storage, branches.BRANCHES_KEY), [SPOON]);
  // The organization it was not in is untouched throughout.
  assert.deepStrictEqual(survivors(storage, SPOON), keysOf(SPOON));
});

test('the last repository of every organization leaves no members entry at all', async () => {
  const storage = stored([SPOON]);

  await forget.repository(SPOON, [], { storage });

  assert.strictEqual(Object.hasOwn(storage.entries, members.MEMBERS_KEY), false);
  assert.strictEqual(Object.hasOwn(storage.entries, branches.BRANCHES_KEY), false);
  assert.deepStrictEqual(Object.keys(storage.entries), [allowlist.STORAGE_KEY]);
});

test('a repository whose name is a prefix of another takes only its own keys', async () => {
  const storage = stored([CON, CONTAINERD]);

  const outcome = await forget.repository(CON, [CONTAINERD], { storage });

  assert.strictEqual(outcome.taken, 4, 'the wrong number of keys was taken');
  assert.deepStrictEqual(survivors(storage, CON), []);
  assert.deepStrictEqual(survivors(storage, CONTAINERD), keysOf(CONTAINERD));
  assert.deepStrictEqual(namesIn(storage, branches.BRANCHES_KEY), [CONTAINERD]);
});

test('a repository whose name another begins with keeps that other one', async () => {
  const storage = stored([CON, CONTAINERD]);

  await forget.repository(CONTAINERD, [CON], { storage });

  assert.deepStrictEqual(survivors(storage, CONTAINERD), []);
  assert.deepStrictEqual(survivors(storage, CON), keysOf(CON));
  assert.deepStrictEqual(namesIn(storage, branches.BRANCHES_KEY), [CON]);
});

test('the keys one repository owns are its own three kinds and nothing else', () => {
  const held = [...keysOf(CONTAINERD), ...keysOf(CON), ...keysOf(SPOON), 'members', 'branches'];

  assert.deepStrictEqual(forget.keysFor(CONTAINERD, held), keysOf(CONTAINERD));
  assert.deepStrictEqual(forget.keysFor(CON, held), keysOf(CON));
  // The comparison folds case, because every key is written folded.
  assert.deepStrictEqual(forget.keysFor(' ContainerD/ContainerD ', held), keysOf(CONTAINERD));
});

test('a value that names no repository takes nothing', async () => {
  const storage = stored([CONTAINERD]);
  const before = structuredClone(storage.entries);

  for (const value of ['', '   ', 'containerd', '/containerd', null, undefined, 42]) {
    const outcome = await forget.repository(value, [], { storage });
    assert.deepStrictEqual(
      outcome,
      { taken: 0, branches: false, members: false },
      `${JSON.stringify(value)} took something`
    );
  }

  assert.deepStrictEqual(storage.entries, before);
});

test('an entry of another shape is left where it stands', async () => {
  const storage = fakeStorage({
    [members.MEMBERS_KEY]: ['samuelkarp'],
    [branches.BRANCHES_KEY]: 'release/2.1',
  });

  const outcome = await forget.repository(CONTAINERD, [], { storage });

  assert.deepStrictEqual(outcome, { taken: 0, branches: false, members: false });
  assert.deepStrictEqual(storage.entries[members.MEMBERS_KEY], ['samuelkarp']);
  assert.strictEqual(storage.entries[branches.BRANCHES_KEY], 'release/2.1');
});

test('a storage that fails leaves the caller with what it had', async () => {
  const storage = {
    entries: {},
    get: async () => {
      throw new Error('storage is unavailable');
    },
    set: async () => {
      throw new Error('storage is unavailable');
    },
    remove: async () => {
      throw new Error('storage is unavailable');
    },
  };

  assert.deepStrictEqual(await forget.everything({ storage }), {
    taken: 0,
    branches: false,
    members: false,
  });
  assert.deepStrictEqual(await forget.repository(CONTAINERD, [], { storage }), {
    taken: 0,
    branches: false,
    members: false,
  });
});

test('outside a browser there is no storage and nothing is taken', async () => {
  cache.setStorage(null);

  assert.deepStrictEqual(await forget.everything(), { taken: 0, branches: false, members: false });
  assert.deepStrictEqual(await forget.repository(CONTAINERD, []), {
    taken: 0,
    branches: false,
    members: false,
  });
});

test('the clear empties the sets this session holds', async () => {
  members.remember({ owner: 'containerd' }, ['samuelkarp']);
  branches.remember({ owner: 'containerd', repo: 'containerd' }, ['release/2.1']);
  assert.strictEqual(members.isKnown({ owner: 'containerd' }, 'samuelkarp'), true);

  await forget.everything({ storage: fakeStorage() });

  assert.strictEqual(members.isKnown({ owner: 'containerd' }, 'samuelkarp'), false);
  assert.deepStrictEqual(branches.known({ owner: 'containerd', repo: 'containerd' }), []);
});
