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
 * @param {number} [jitterMs] What the entry drew when it was written.
 * @returns {import('../src/common/cache.js').CacheEntry}
 */
function entry(observedAt, state, jitterMs = 0) {
  return { record: { state }, observedAt, state, jitterMs };
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
  assert.ok(cache.lifeOf('published') === 90 * DAY, `published life was ${cache.lifeOf('published')}`);
  assert.ok(cache.lifeOf('withdrawn') === 90 * DAY, `withdrawn life was ${cache.lifeOf('withdrawn')}`);
  assert.ok(cache.lifeOf('Triage') === 7 * DAY, 'the state is read case-insensitively');
  assert.ok(cache.lifeOf(null) === 7 * DAY, 'an entry naming no state takes the shortest life');
});

test('a draw lengthens the two long lives and no others', () => {
  assert.ok(
    cache.lifeOf('published', 3 * DAY) === 93 * DAY,
    `a published entry that drew three days lived ${cache.lifeOf('published', 3 * DAY)}`
  );
  assert.ok(cache.lifeOf('withdrawn', DAY) === 91 * DAY, 'a withdrawn entry ignored its draw');
  for (const state of ['triage', 'draft', 'closed', null]) {
    assert.ok(
      cache.lifeOf(state, 3 * DAY) === cache.lifeOf(state),
      `${state} took a draw it is not meant to carry`
    );
  }
  assert.ok(
    cache.lifeOf('published', 400 * DAY) === 104 * DAY,
    'a draw beyond a fortnight was not held to one'
  );
  for (const drawn of [Number.NaN, Number.POSITIVE_INFINITY, -5 * DAY]) {
    assert.ok(
      cache.lifeOf('published', drawn) === 90 * DAY,
      `a draw of ${drawn} was taken as a duration`
    );
  }
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

test('a done entry expires at ninety days plus its own draw', () => {
  for (const state of ['published', 'withdrawn']) {
    const plain = entry(0, state);
    assert.ok(!cache.isExpired(plain, 30 * DAY), `${state} expired on the closed schedule`);
    assert.ok(!cache.isExpired(plain, 90 * DAY - 1), `${state} expired one millisecond early`);
    assert.ok(cache.isExpired(plain, 90 * DAY), `${state} outlived ninety days`);
    const drawn = entry(0, state, 5 * DAY);
    assert.ok(!cache.isExpired(drawn, 95 * DAY - 1), `${state} expired one millisecond into a draw`);
    assert.ok(cache.isExpired(drawn, 95 * DAY), `${state} outlived its ninety days and its draw`);
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

test('an entry stamped with no real moment reads as absent', async () => {
  const storage = fakeStorage({ [KEY]: { record: { state: 'triage' }, observedAt: Number.NaN } });
  assert.ok(
    (await cache.getEntry(KEY, { storage, at: 40 * DAY })) === null,
    'an entry stamped NaN was handed back'
  );
  assert.ok(cache.entryFrom({ record: {}, observedAt: Number.NaN }) === null, 'NaN read as a time');
  assert.ok(
    cache.entryFrom({ record: {}, observedAt: Number.POSITIVE_INFINITY }) === null,
    'an endless time read as a time'
  );

  // Why the stamp is checked: every comparison against a stamp that is not a
  // real moment answers false, so an entry carrying one would be fresh for
  // ever and would never reach the end of its life.
  const unreal = { record: {}, observedAt: Number.NaN, state: 'triage' };
  assert.ok(!cache.isStale(unreal, 40 * DAY), 'a NaN stamp read as stale');
  assert.ok(!cache.isExpired(unreal, 40 * DAY), 'a NaN stamp read as expired');
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

test('the jitter is drawn once, at write time, and held on the entry', async () => {
  const storage = fakeStorage();
  /** @type {number[]} */
  const draws = [0.25, 0.75];
  cache.setClock(() => 0);
  cache.setRandom(() => draws.shift() ?? 0);
  try {
    const other = { ...REF, ghsaId: 'GHSA-dead-beef-cafe' };
    const first = await cache.putAdvisory(REF, { state: 'published' }, { storage });
    const second = await cache.putAdvisory(other, { state: 'published' }, { storage });
    assert.ok(first !== null && first.jitterMs === 3.5 * DAY, `the first drew ${first?.jitterMs}`);
    assert.ok(second !== null && second.jitterMs === 10.5 * DAY, `the second drew ${second?.jitterMs}`);

    // The draw is on the stored entry, so the moment it falls due is fixed
    // when it is written and does not move when someone reads it.
    const stored = storage.entries[KEY];
    const jitterMs = cache.entryFrom(stored)?.jitterMs;
    assert.ok(jitterMs === first.jitterMs, `storage held a draw of ${jitterMs}`);
    cache.setRandom(() => 0.99);
    const reread = await cache.getAdvisory(REF, { storage });
    assert.ok(reread !== null && reread.jitterMs === first.jitterMs, 'the draw moved between reads');

    const open = await cache.putAdvisory(other, { state: 'triage' }, { storage });
    assert.ok(open !== null && open.jitterMs === 0, `a triage entry drew ${open?.jitterMs}`);
  } finally {
    cache.setClock(null);
    cache.setRandom(null);
  }
});

test('a drawn entry is held to the end of its life and then discarded', async () => {
  const storage = fakeStorage();
  let clock = 0;
  cache.setClock(() => clock);
  cache.setRandom(() => 0.5);
  try {
    const written = await cache.putAdvisory(REF, { state: 'published' }, { storage });
    assert.ok(written !== null && written.jitterMs === 7 * DAY, `the entry drew ${written?.jitterMs}`);
    clock = 97 * DAY - 1;
    assert.ok((await cache.getAdvisory(REF, { storage })) !== null, 'discarded one millisecond early');
    assert.ok(Object.hasOwn(storage.entries, KEY), 'a live entry was taken out of storage');
    clock = 97 * DAY;
    assert.ok((await cache.getAdvisory(REF, { storage })) === null, 'held past ninety-seven days');
    assert.ok(!Object.hasOwn(storage.entries, KEY), 'the expired entry stayed in storage');
  } finally {
    cache.setClock(null);
    cache.setRandom(null);
  }
});

test('an entry written before the draw lives the plain ninety days', async () => {
  const held = { record: { state: 'published' }, observedAt: 0, state: 'published' };
  const early = fakeStorage({ [KEY]: { ...held } });
  const inside = await cache.getEntry(KEY, { storage: early, at: 90 * DAY - 1 });
  assert.ok(inside !== null, 'an entry carrying no draw was discarded before ninety days');
  assert.ok(inside.jitterMs === 0, `a missing draw read as ${inside?.jitterMs}`);
  assert.ok(
    (await cache.getEntry(KEY, { storage: early, at: 90 * DAY })) === null,
    'an entry carrying no draw outlived ninety days'
  );
  assert.ok(!Object.hasOwn(early.entries, KEY), 'the expired entry stayed in storage');

  // A stored draw that is not a real duration is no draw. Every comparison
  // against one answers false, so an entry carrying one would never reach the
  // end of its life.
  const unreal = fakeStorage({ [KEY]: { ...held, jitterMs: Number.NaN } });
  assert.ok(
    (await cache.getEntry(KEY, { storage: unreal, at: 90 * DAY })) === null,
    'an entry carrying a NaN draw was handed back'
  );
});
