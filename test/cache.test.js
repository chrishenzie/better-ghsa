'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../src/common/cache.js');

// A stand-in for `browser.storage.local`. Its `get(null)` answers with
// everything, which is what the real one does and what the clear reads.
const { fakeStorage } = require('../test-support/storage.js');

/** @typedef {import('../test-support/storage.js').FakeStorage} Fake */

/** The advisory every test here reads and writes. */
const REF = { owner: 'containerd', repo: 'containerd', ghsaId: 'GHSA-1234-5678-9abc' };

/** The key that advisory's entry is held under. */
const KEY = 'adv:containerd/containerd:ghsa-1234-5678-9abc';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/**
 * @param {number} observedAt
 * @param {string | null} state
 * @returns {import('../src/common/cache.js').CacheEntry}
 */
function entry(observedAt, state) {
  return { record: { state }, observedAt, state };
}

test('an advisory key names the owner, the repository, and the advisory', () => {
  assert.ok(cache.advisoryKey(REF) === KEY, `advisory key was ${cache.advisoryKey(REF)}`);
  assert.ok(
    cache.advisoryKey({ owner: 'Containerd', repo: 'ContainerD', ghsaId: 'ghsa-1234-5678-9ABC' }) ===
      KEY,
    'a differently spelled reference names a different key'
  );
  assert.ok(cache.advisoryKey({ owner: 'x', repo: '', ghsaId: 'y' }) === null, 'no repository');
  assert.ok(cache.advisoryKey(null) === null, 'no reference');
});

test('the list and progress entries are keyed by repository', () => {
  assert.ok(
    cache.listKey(REF) === 'list:containerd/containerd',
    `list key was ${cache.listKey(REF)}`
  );
  assert.ok(
    cache.progressKey(REF) === 'queue:containerd/containerd',
    `progress key was ${cache.progressKey(REF)}`
  );
  assert.ok(cache.isCacheKey(KEY), 'an advisory key belongs to the cache');
  assert.ok(cache.isCacheKey('list:containerd/containerd'), 'a list key belongs to the cache');
  assert.ok(cache.isCacheKey('queue:containerd/containerd'), 'a progress key belongs to the cache');
  assert.ok(!cache.isCacheKey('members'), 'the members entry is not the cache');
  assert.ok(!cache.isCacheKey('branches'), 'the branches entry is not the cache');
});

test('entry life follows the advisory state', () => {
  assert.ok(cache.lifeOf('triage') === 7 * DAY, `triage life was ${cache.lifeOf('triage')}`);
  assert.ok(cache.lifeOf('draft') === 7 * DAY, `draft life was ${cache.lifeOf('draft')}`);
  assert.ok(cache.lifeOf('closed') === 30 * DAY, `closed life was ${cache.lifeOf('closed')}`);
  assert.ok(cache.lifeOf('published') === null, 'a published entry lives indefinitely');
  assert.ok(cache.lifeOf('withdrawn') === null, 'a withdrawn entry lives indefinitely');
  assert.ok(cache.lifeOf('Triage') === 7 * DAY, 'the state is read case-insensitively');
  assert.ok(cache.lifeOf(null) === 7 * DAY, 'an entry naming no state takes the shortest life');
});

test('an open entry expires at seven days and not before', () => {
  for (const state of ['triage', 'draft']) {
    const held = entry(0, state);
    assert.ok(!cache.isExpired(held, 7 * DAY - 1), `${state} expired one millisecond early`);
    assert.ok(cache.isExpired(held, 7 * DAY), `${state} outlived seven days`);
  }
});

test('a closed entry expires at thirty days and not before', () => {
  const held = entry(0, 'closed');
  assert.ok(!cache.isExpired(held, 7 * DAY), 'a closed entry expired on the open schedule');
  assert.ok(!cache.isExpired(held, 30 * DAY - 1), 'a closed entry expired one millisecond early');
  assert.ok(cache.isExpired(held, 30 * DAY), 'a closed entry outlived thirty days');
});

test('a published or withdrawn entry never expires', () => {
  for (const state of ['published', 'withdrawn']) {
    assert.ok(!cache.isExpired(entry(0, state), 365 * DAY), `${state} expired after a year`);
  }
});

test('staleness is five minutes and is not entry life', () => {
  const held = entry(0, 'triage');
  assert.ok(!cache.isStale(held, 5 * MINUTE - 1), 'an entry went stale one millisecond early');
  assert.ok(cache.isStale(held, 5 * MINUTE), 'an entry five minutes old was not stale');
  // The two thresholds are separate: an entry is refreshed long before it is
  // discarded, and it is read from all the while.
  assert.ok(cache.isStale(held, 6 * DAY), 'a six-day-old triage entry was not stale');
  assert.ok(!cache.isExpired(held, 6 * DAY), 'a six-day-old triage entry was discarded');
});

test('an entry within its life is read back with what was written', async () => {
  const storage = fakeStorage();
  const record = { state: 'Triage', ghsaId: REF.ghsaId, title: 'A hole' };
  const written = await cache.putAdvisory(REF, record, { storage, at: 1000 });
  assert.ok(written !== null && written.observedAt === 1000, 'the write did not stamp the time');
  assert.ok(written.state === 'triage', `the entry state was ${written?.state}`);

  const held = await cache.getEntry(KEY, { storage, at: 1000 + 4 * MINUTE });
  assert.ok(held !== null, 'the entry was not read back');
  assert.ok(held.observedAt === 1000, `the entry was observed at ${held?.observedAt}`);
  assert.ok(
    /** @type {{ title?: unknown }} */ (held.record).title === 'A hole',
    'the record did not survive the round trip'
  );
  assert.ok(!cache.isStale(held, 1000 + 4 * MINUTE), 'a four-minute-old entry was stale');
});

test('a read past the entry life answers absent and discards the entry', async () => {
  const storage = fakeStorage();
  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 0 });
  const held = await cache.getAdvisory(REF, { storage, at: 7 * DAY });
  assert.ok(held === null, 'an expired entry was handed back');
  assert.ok(!Object.hasOwn(storage.entries, KEY), 'the expired entry is still in storage');
  assert.ok(storage.removals.length === 1, `storage saw ${storage.removals.length} removals`);
});

test('many advisories are read in one call, expired ones absent', async () => {
  const storage = fakeStorage();
  const ids = ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb', 'GHSA-cccc-cccc-cccc'];
  await cache.putAdvisory({ ...REF, ghsaId: ids[0] }, { state: 'triage' }, { storage, at: 0 });
  await cache.putAdvisory({ ...REF, ghsaId: ids[1] }, { state: 'closed' }, { storage, at: 0 });

  const found = await cache.getAdvisories(REF, ids, { storage, at: 8 * DAY });
  assert.ok(found.size === 1, `${found.size} entries were held`);
  assert.ok(found.has(ids[1] ?? ''), 'the closed entry was not held at eight days');
  assert.ok(!found.has(ids[0] ?? ''), 'the triage entry outlived seven days');
  assert.ok(storage.reads.length === 1, `storage saw ${storage.reads.length} reads`);
});

test('the list entry and the progress entry round trip', async () => {
  const storage = fakeStorage();
  await cache.putList(REF, { rows: [{ ghsaId: REF.ghsaId }] }, { storage, at: 500 });
  const list = await cache.getList(REF, { storage, at: 600 });
  assert.ok(list !== null && list.observedAt === 500, 'the list entry was not read back');
  assert.ok(list.state === null, `the list entry state was ${list?.state}`);

  await cache.putProgress(REF, { pending: ['GHSA-aaaa-aaaa-aaaa'] }, { storage, at: 500 });
  const progress = await cache.getProgress(REF, { storage, at: 600 });
  const pending = /** @type {{ pending?: unknown }} */ (progress).pending;
  assert.ok(Array.isArray(pending) && pending.length === 1, 'the progress entry was not read back');

  await cache.clearProgress(REF, { storage });
  assert.ok((await cache.getProgress(REF, { storage, at: 600 })) === null, 'progress survived');
});

test('the clear takes the cache and leaves members and branches', async () => {
  const storage = fakeStorage({
    members: { containerd: ['samuelkarp'] },
    branches: { 'containerd/containerd': ['release/2.1'] },
  });
  await cache.putAdvisory(REF, { state: 'triage' }, { storage, at: 0 });
  await cache.putList(REF, { rows: [] }, { storage, at: 0 });
  await cache.putProgress(REF, { pending: [] }, { storage, at: 0 });

  const taken = await cache.clear({ storage });
  assert.ok(taken === 3, `the clear took ${taken} entries`);
  assert.ok(!Object.hasOwn(storage.entries, KEY), 'the advisory entry survived the clear');
  assert.ok(!Object.hasOwn(storage.entries, 'list:containerd/containerd'), 'the list entry survived');
  assert.ok(
    !Object.hasOwn(storage.entries, 'queue:containerd/containerd'),
    'the progress entry survived the clear'
  );
  assert.ok(Object.hasOwn(storage.entries, 'members'), 'the clear took the members entry');
  assert.ok(Object.hasOwn(storage.entries, 'branches'), 'the clear took the branches entry');
});

test('an entry of another shape reads as absent', async () => {
  const storage = fakeStorage({ [KEY]: { record: {}, observedAt: 'lately' } });
  assert.ok((await cache.getEntry(KEY, { storage, at: 0 })) === null, 'a bad entry was handed back');
  assert.ok(cache.entryFrom(null) === null, 'null read as an entry');
  assert.ok(cache.entryFrom({ record: {}, observedAt: 12 }) !== null, 'a good entry read as absent');
});

test('storage failing is an absent entry and an unwritten one', async () => {
  /** @type {import('../src/common/cache.js').CacheStorage} */
  const storage = {
    get: async () => {
      throw new Error('storage is gone');
    },
    set: async () => {
      throw new Error('storage is gone');
    },
    remove: async () => {
      throw new Error('storage is gone');
    },
  };
  assert.ok((await cache.getAdvisory(REF, { storage })) === null, 'a failed read was not absent');
  assert.ok((await cache.putAdvisory(REF, {}, { storage })) === null, 'a failed write reported one');
  assert.ok((await cache.clear({ storage })) === 0, 'a failed clear reported entries taken');
  assert.ok((await cache.getAdvisories(REF, ['GHSA-a'], { storage })).size === 0, 'a failed read');
});

test('the clock is injectable and the entry stamps read from it', async () => {
  const storage = fakeStorage();
  let clock = 10_000;
  cache.setClock(() => clock);
  try {
    const written = await cache.putAdvisory(REF, { state: 'triage' }, { storage });
    assert.ok(written !== null && written.observedAt === 10_000, 'the injected clock was not read');
    clock += 4 * MINUTE;
    const fresh = await cache.getAdvisory(REF, { storage });
    assert.ok(fresh !== null && !cache.isStale(fresh), 'a four-minute-old entry was stale');
    clock += MINUTE;
    const stale = await cache.getAdvisory(REF, { storage });
    assert.ok(stale !== null && cache.isStale(stale), 'a five-minute-old entry was fresh');
  } finally {
    cache.setClock(null);
  }
});
