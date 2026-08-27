'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../src/common/cache.js');
const queues = require('../src/common/fetch.js');

// A stand-in for `browser.storage.local`. Two queues sharing one of these are
// two page loads sharing one browser profile.
const { fakeStorage } = require('../test-support/storage.js');

/** @typedef {import('../test-support/storage.js').FakeStorage} Fake */

/**
 * A clock a test moves by hand, and the wait the queue uses with it. Waiting
 * moves the clock and returns at once, so a pass of a hundred advisories costs
 * no time and the intervals are still exact.
 *
 * @param {number} [start]
 */
function fakeClock(start = 0) {
  let at = start;
  /** @type {number[]} */
  const waits = [];
  return {
    waits,
    now: () => at,
    /** @param {number} ms */
    advance: (ms) => {
      at += ms;
    },
    /** @param {number} ms */
    wait: async (ms) => {
      waits.push(ms);
      at += ms;
    },
  };
}

/** The repository every pass here reads. */
const REF = { owner: 'containerd', repo: 'containerd' };

const MINUTE = 60 * 1000;

/**
 * @param {string} suffix
 * @returns {string}
 */
function ghsa(suffix) {
  return `GHSA-${suffix}-${suffix}-${suffix}`;
}

/**
 * A fetch that answers every advisory page, recording the moment each request
 * went out on the clock the queue reads.
 *
 * @param {ReturnType<typeof fakeClock>} clock
 * @param {(url: string) => { status: number, body?: string }} [answer]
 */
function fakeFetch(clock, answer = () => ({ status: 200 })) {
  /** @type {string[]} */
  const urls = [];
  /** @type {number[]} */
  const at = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    urls.push(url);
    at.push(clock.now());
    const { status, body } = answer(url);
    return { status, text: async () => body ?? '<html></html>' };
  };
  return { urls, at, send };
}

/**
 * @param {ReturnType<typeof fakeClock>} clock
 * @param {Fake} storage
 * @param {Partial<import('../src/common/fetch.js').QueueOptions>} [extra]
 * @returns {import('../src/common/fetch.js').QueueOptions}
 */
function options(clock, storage, extra = {}) {
  return {
    ref: REF,
    storage,
    now: clock.now,
    wait: clock.wait,
    parse: (_html, ref) => ({ state: 'triage', ghsaId: ref.ghsaId }),
    ...extra,
  };
}

test('a plan reads never-seen advisories first, then stalest first', () => {
  const at = 100 * MINUTE;
  /** @type {Map<string, import('../src/common/cache.js').CacheEntry>} */
  const entries = new Map([
    [ghsa('aaaa'), { record: {}, observedAt: at - 40 * MINUTE, state: 'triage' }],
    [ghsa('bbbb'), { record: {}, observedAt: at - 90 * MINUTE, state: 'triage' }],
    [ghsa('dddd'), { record: {}, observedAt: at - 4 * MINUTE, state: 'triage' }],
  ]);
  const { order, fresh } = queues.plan(
    [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc'), ghsa('dddd')],
    entries,
    at
  );
  assert.deepStrictEqual(order, [ghsa('cccc'), ghsa('bbbb'), ghsa('aaaa')]);
  assert.deepStrictEqual(fresh, [ghsa('dddd')]);
});

test('an advisory observed four minutes ago is not fetched and five is', async () => {
  const clock = fakeClock(10 * MINUTE);
  const storage = fakeStorage();
  await cache.putAdvisory(
    { ...REF, ghsaId: ghsa('aaaa') },
    { state: 'triage' },
    { storage, at: clock.now() - 4 * MINUTE }
  );
  await cache.putAdvisory(
    { ...REF, ghsaId: ghsa('bbbb') },
    { state: 'triage' },
    { storage, at: clock.now() - 5 * MINUTE }
  );
  const fetch = fakeFetch(clock);
  /** @type {string[]} */
  const reported = [];
  const queue = queues.createQueue(
    options(clock, storage, { fetch: fetch.send, onEntry: (ghsaId) => reported.push(ghsaId) })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  const summary = await queue.run();

  assert.deepStrictEqual(fetch.urls, [
    `/containerd/containerd/security/advisories/${ghsa('bbbb')}`,
  ]);
  assert.ok(summary.fetched === 1, `${summary.fetched} advisories were fetched`);
  assert.ok(summary.skipped === 1, `${summary.skipped} advisories were skipped`);
  // The fresh one still reaches the caller, from the cache, so its row paints.
  assert.deepStrictEqual(reported.sort(), [ghsa('aaaa'), ghsa('bbbb')]);
});

test('requests go out one second apart on the injected clock', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  await queue.add([ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
  await queue.run();

  assert.ok(fetch.at.length === 3, `${fetch.at.length} requests went out`);
  assert.deepStrictEqual(fetch.at, [0, 1000, 2000]);
  assert.deepStrictEqual(clock.waits, [1000, 1000]);
});

test('a pass interrupted in flight resumes without losing or repeating work', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();

  /** @type {(url: string) => void} */
  let reached = () => {};
  const arrived = new Promise((resolve) => {
    reached = /** @type {(url: string) => void} */ (resolve);
  });
  /** @type {string[]} */
  const asked = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const stalls = async (url) => {
    asked.push(url);
    if (asked.length === 1) return { status: 200, text: async () => '<html></html>' };
    reached(url);
    // The page went away with this request in flight: it never answers.
    return new Promise(() => {});
  };

  const one = queues.createQueue(options(clock, storage, { fetch: stalls }));
  await one.add([ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
  void one.run();
  await arrived;

  const held = queues.progressFrom(await cache.getProgress(REF, { storage, at: clock.now() }));
  assert.ok(held !== null, 'the interrupted pass left no progress');
  assert.ok(held.inFlight === ghsa('bbbb'), `the record named ${held?.inFlight} in flight`);
  assert.deepStrictEqual(held.done, [ghsa('aaaa')], 'the first read was not recorded done');
  assert.deepStrictEqual(held.pending, [ghsa('cccc')], 'the rest of the queue was not held');

  // The next page load. The advisory that was in flight goes back at the head,
  // and the one the first pass finished is fresh in the cache, so it is not
  // asked for a second time.
  const next = fakeFetch(clock);
  const two = queues.createQueue(options(clock, storage, { fetch: next.send }));
  const resumed = await two.load();
  assert.ok(resumed !== null, 'nothing was resumed');
  assert.deepStrictEqual(two.progress().pending, [ghsa('bbbb'), ghsa('cccc')]);

  const summary = await two.run();
  assert.deepStrictEqual(
    next.urls.map((url) => url.split('/').pop()),
    [ghsa('bbbb'), ghsa('cccc')],
    'the resumed pass asked for the wrong advisories'
  );
  assert.ok(summary.fetched === 2, `${summary.fetched} advisories were fetched on the resume`);
  assert.ok(summary.complete, 'the resumed pass did not finish');
});

test('an answer that landed before the page went away is not fetched again', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  // The entry was written and the progress record was not, which is the window
  // between the cache write and the progress write.
  await cache.putAdvisory(
    { ...REF, ghsaId: ghsa('bbbb') },
    { state: 'triage' },
    { storage, at: clock.now() }
  );
  await cache.putProgress(
    REF,
    {
      pending: [ghsa('cccc')],
      inFlight: ghsa('bbbb'),
      done: [ghsa('aaaa')],
      failed: [],
      lastRequestAt: clock.now(),
      startedAt: 0,
      updatedAt: clock.now(),
    },
    { storage, at: clock.now() }
  );

  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  await queue.load();
  const summary = await queue.run();

  assert.deepStrictEqual(
    fetch.urls.map((url) => url.split('/').pop()),
    [ghsa('cccc')],
    'the advisory whose answer had landed was fetched again'
  );
  assert.ok(summary.skipped === 1, `${summary.skipped} advisories were skipped`);
});

test('a finished pass leaves nothing to resume and the request time', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(options(clock, storage, { fetch: fetch.send }));
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  assert.ok(
    Object.hasOwn(storage.entries, 'queue:containerd/containerd'),
    'queueing left no progress'
  );
  const summary = await queue.run();
  assert.ok(summary.complete, 'the pass did not finish');

  const held = queues.progressFrom(await cache.getProgress(REF, { storage, at: clock.now() }));
  assert.ok(held !== null, 'a finished pass left no record of when it last asked');
  assert.deepStrictEqual(held.pending, [], 'a finished pass left work to resume');
  assert.ok(held.inFlight === null, 'a finished pass left a request in flight');
  assert.ok(held.lastRequestAt === 1000, `the last request was recorded at ${held?.lastRequestAt}`);
});

test('a stopped pass holds what is left for the next page', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      onEntry: (ghsaId) => {
        if (ghsaId === ghsa('aaaa')) queue.stop();
      },
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')]);
  const summary = await queue.run();

  assert.ok(fetch.urls.length === 1, `${fetch.urls.length} requests went out`);
  assert.ok(!summary.complete, 'a stopped pass reported itself finished');
  assert.deepStrictEqual(summary.remaining, [ghsa('bbbb'), ghsa('cccc')]);
  const held = queues.progressFrom(await cache.getProgress(REF, { storage, at: clock.now() }));
  assert.deepStrictEqual(held?.pending, [ghsa('bbbb'), ghsa('cccc')]);
});

test('a failed read caches nothing and the pass carries on', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock, (url) =>
    url.endsWith(ghsa('aaaa')) ? { status: 404 } : { status: 200 }
  );
  /** @type {string[]} */
  const failures = [];
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      onFailure: (ghsaId, reason) => failures.push(`${ghsaId}: ${String(reason)}`),
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  const summary = await queue.run();

  assert.ok(summary.failed === 1, `${summary.failed} reads failed`);
  assert.ok(summary.fetched === 1, `${summary.fetched} advisories were fetched`);
  assert.deepStrictEqual(failures, [`${ghsa('aaaa')}: GitHub answered 404.`]);
  assert.ok(
    (await cache.getAdvisory({ ...REF, ghsaId: ghsa('aaaa') }, { storage, at: clock.now() })) ===
      null,
    'a failed read was cached'
  );
  // A request went out for the failed read, so the next one still waits.
  assert.deepStrictEqual(fetch.at, [0, 1000]);
});

test('an advisory refreshed mid-pass is dropped from the queue', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      onEntry: async (ghsaId) => {
        // Reading the detail page of the next advisory refreshes its entry from
        // the live DOM while this pass is running.
        if (ghsaId !== ghsa('aaaa')) return;
        await cache.putAdvisory(
          { ...REF, ghsaId: ghsa('bbbb') },
          { state: 'draft' },
          { storage, at: clock.now() }
        );
      },
    })
  );
  await queue.add([ghsa('aaaa'), ghsa('bbbb')]);
  const summary = await queue.run();

  assert.deepStrictEqual(
    fetch.urls.map((url) => url.split('/').pop()),
    [ghsa('aaaa')],
    'the advisory refreshed mid-pass was fetched anyway'
  );
  assert.ok(summary.skipped === 1, `${summary.skipped} advisories were skipped`);
});

test('what a read holds is the parsed record, stamped with the read time', async () => {
  const clock = fakeClock(7 * MINUTE);
  const storage = fakeStorage();
  const fetch = fakeFetch(clock);
  const queue = queues.createQueue(
    options(clock, storage, {
      fetch: fetch.send,
      parse: (html, ref) => ({ state: 'Draft', ghsaId: ref.ghsaId, title: html.length }),
    })
  );
  await queue.add([ghsa('aaaa')]);
  await queue.run();

  const entry = await cache.getAdvisory(
    { ...REF, ghsaId: ghsa('aaaa') },
    { storage, at: clock.now() }
  );
  assert.ok(entry !== null, 'the read was not cached');
  assert.ok(entry.observedAt === 7 * MINUTE, `the entry was observed at ${entry?.observedAt}`);
  assert.ok(entry.state === 'draft', `the entry state was ${entry?.state}`);
  assert.ok(
    /** @type {{ ghsaId?: unknown }} */ (entry.record).ghsaId === ghsa('aaaa'),
    'the record is not what the parse returned'
  );
});

test('a progress record of another shape resumes nothing', async () => {
  const clock = fakeClock(0);
  const storage = fakeStorage();
  await cache.putProgress(REF, { pending: 'everything' }, { storage, at: 0 });
  const queue = queues.createQueue(options(clock, storage, { fetch: fakeFetch(clock).send }));
  const held = await queue.load();
  assert.deepStrictEqual(held?.pending, [], 'a malformed pending list was taken as advisories');
  assert.ok(queues.progressFrom(null) === null, 'null read as progress');
  assert.ok(queues.progressFrom(12) === null, 'a number read as progress');
});
