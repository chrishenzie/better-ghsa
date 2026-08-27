'use strict';

const test = require('node:test');
const assert = require('node:assert');

const order = require('../src/common/order.js');

/**
 * An advisory the table holds. The defaults are the least urgent thing an entry
 * can be: reviewed, quiet, unscored, and waiting on nobody in particular.
 *
 * @param {string} ghsaId
 * @param {Partial<import('../src/common/order.js').OrderEntry>} [fields]
 * @returns {import('../src/common/order.js').OrderEntry}
 */
function entry(ghsaId, fields = {}) {
  return {
    ghsaId,
    neverReviewed: false,
    newActivity: false,
    triage: null,
    embargoOverdue: false,
    severity: null,
    severityConfirmed: false,
    waitingSince: null,
    ...fields,
  };
}

/**
 * @param {readonly import('../src/common/order.js').OrderEntry[]} entries
 * @param {readonly string[]} wanted
 * @param {string} what
 */
function ordersAs(entries, wanted, what) {
  const sorted = order.sort(entries);
  assert.strictEqual(sorted.length, wanted.length, `${what}: entry count`);
  for (let i = 0; i < wanted.length; i += 1) {
    assert.ok(
      sorted[i]?.ghsaId === wanted[i],
      `${what}: position ${i} holds ${sorted[i]?.ghsaId} where ${wanted[i]} belongs`
    );
  }
}

test('the four tiers come in the order section 9 states', () => {
  const reviewed = entry('D', { triage: 'awaiting reporter' });
  const ours = entry('C', { triage: 'evaluating' });
  const activity = entry('B', { newActivity: true, triage: 'awaiting reporter' });
  const fresh = entry('A', { neverReviewed: true, triage: 'awaiting reporter' });
  assert.strictEqual(order.tierOf(fresh), 1);
  assert.strictEqual(order.tierOf(activity), 2);
  assert.strictEqual(order.tierOf(ours), 3);
  assert.strictEqual(order.tierOf(reviewed), 4);
  assert.strictEqual(order.tierName(order.tierOf(ours)), 'blocked on us');
  ordersAs([reviewed, ours, activity, fresh], ['A', 'B', 'C', 'D'], 'the tiers');
});

test('never reviewed outranks new activity on an advisory that is both', () => {
  const both = entry('A', { neverReviewed: true, newActivity: true });
  const activity = entry('B', { newActivity: true });
  assert.strictEqual(order.tierOf(both), 1);
  ordersAs([activity, both], ['A', 'B'], 'a never reviewed advisory with new activity');
});

test('every triage value says which side the advisory waits on', () => {
  assert.strictEqual(order.classifyTriage('evaluating'), 'us');
  assert.strictEqual(order.classifyTriage('awaiting maintainer input'), 'us');
  assert.strictEqual(order.classifyTriage('awaiting reporter'), 'reporter');
  assert.strictEqual(order.classifyTriage('Awaiting Reporter'), 'reporter');
  assert.strictEqual(order.classifyTriage(null), 'us', 'an advisory nobody has classified is ours');
  assert.strictEqual(order.classifyTriage('parked'), 'us', 'a value this reader does not know');
  assert.strictEqual(order.tierOf(entry('A', { triage: 'awaiting maintainer input' })), 3);
  assert.strictEqual(order.tierOf(entry('A', { triage: 'evaluating' })), 3);
  assert.strictEqual(order.tierOf(entry('A', { triage: 'awaiting reporter' })), 4);
});

test('an overdue embargo sorts to the top of the blocked-on-us tier', () => {
  const overdue = entry('A', {
    triage: 'evaluating',
    embargoOverdue: true,
    severity: 'low',
    waitingSince: '2026-08-20T00:00:00Z',
  });
  const critical = entry('B', {
    triage: 'evaluating',
    severity: 'critical',
    severityConfirmed: true,
    waitingSince: '2026-01-01T00:00:00Z',
  });
  ordersAs([critical, overdue], ['A', 'B'], 'an overdue embargo above a confirmed critical');
});

test('an overdue embargo does not lift an advisory out of its tier', () => {
  // Section 9 puts an overdue embargo at the top of the blocked-on-us tier,
  // and says nothing that moves one between tiers.
  const overdue = entry('B', { triage: 'awaiting reporter', embargoOverdue: true });
  const ours = entry('A', { triage: 'evaluating' });
  ordersAs([overdue, ours], ['A', 'B'], 'an overdue embargo on the reporter');
});

test('an overdue embargo does not reorder the blocked-on-reporter tier', () => {
  const overdue = entry('B', {
    triage: 'awaiting reporter',
    embargoOverdue: true,
    waitingSince: '2026-08-01T00:00:00Z',
  });
  const older = entry('A', {
    triage: 'awaiting reporter',
    waitingSince: '2026-07-01T00:00:00Z',
  });
  ordersAs([overdue, older], ['A', 'B'], 'the longest waiting first whatever the embargo');
});

test('a confirmed severity outranks every unconfirmed one', () => {
  const confirmedLow = entry('A', {
    triage: 'evaluating',
    severity: 'low',
    severityConfirmed: true,
  });
  const claimedCritical = entry('B', { triage: 'evaluating', severity: 'critical' });
  ordersAs([claimedCritical, confirmedLow], ['A', 'B'], 'a confirmed score above a claimed one');
});

test('confirmed severities sort highest first, then unconfirmed severities', () => {
  const entries = [
    entry('D', { triage: 'evaluating', severity: 'low' }),
    entry('B', { triage: 'evaluating', severity: 'high', severityConfirmed: true }),
    entry('C', { triage: 'evaluating', severity: 'critical' }),
    entry('A', { triage: 'evaluating', severity: 'critical', severityConfirmed: true }),
    entry('E', { triage: 'evaluating' }),
  ];
  ordersAs(entries, ['A', 'B', 'C', 'D', 'E'], 'severity within the blocked-on-us tier');
  assert.strictEqual(order.severityRank('critical'), 4);
  assert.strictEqual(order.severityRank('high'), 3);
  assert.strictEqual(order.severityRank('moderate'), 2);
  assert.strictEqual(order.severityRank('low'), 1);
  assert.strictEqual(order.severityRank(null), 0);
  assert.strictEqual(order.severityRank('unknown'), 0);
});

test('the longest waiting breaks a tie inside the blocked-on-us tier', () => {
  const entries = [
    entry('C', { triage: 'evaluating', severity: 'high', waitingSince: '2026-08-20T00:00:00Z' }),
    entry('A', { triage: 'evaluating', severity: 'high', waitingSince: '2026-06-01T00:00:00Z' }),
    entry('B', { triage: 'evaluating', severity: 'high', waitingSince: '2026-08-19T23:59:59Z' }),
  ];
  ordersAs(entries, ['A', 'B', 'C'], 'the longest waiting of three equal severities');
});

test('the never reviewed tier is the longest waiting first', () => {
  const entries = [
    entry('A', { neverReviewed: true, waitingSince: '2026-08-01T00:00:00Z' }),
    entry('B', { neverReviewed: true, waitingSince: null }),
    entry('C', { neverReviewed: true, waitingSince: '2025-12-31T00:00:00Z' }),
  ];
  ordersAs(entries, ['C', 'A', 'B'], 'never reviewed by waiting, not by identifier');
});

test('the new activity tier is the longest waiting first', () => {
  const entries = [
    entry('A', { newActivity: true, waitingSince: '2026-08-01T00:00:00Z' }),
    entry('B', { newActivity: true, waitingSince: null }),
    entry('C', { newActivity: true, waitingSince: '2025-12-31T00:00:00Z' }),
  ];
  ordersAs(entries, ['C', 'A', 'B'], 'new activity by waiting, not by identifier');
});

test('the blocked-on-reporter tier is the longest waiting first', () => {
  const entries = [
    entry('B', { triage: 'awaiting reporter', waitingSince: '2026-08-01T00:00:00Z' }),
    entry('A', { triage: 'awaiting reporter', waitingSince: '2025-12-31T00:00:00Z' }),
    entry('C', { triage: 'awaiting reporter', waitingSince: null }),
  ];
  ordersAs(entries, ['A', 'B', 'C'], 'a waiting time that went unread sorts last');
});

test('a severity outranks the longest wait inside the blocked-on-us tier', () => {
  const waited = entry('B', { triage: 'evaluating', waitingSince: '2020-01-01T00:00:00Z' });
  const severe = entry('A', {
    triage: 'evaluating',
    severity: 'moderate',
    waitingSince: '2026-08-25T00:00:00Z',
  });
  ordersAs([waited, severe], ['A', 'B'], 'severity above waiting');
});

/** A grid of entries covering every combination the comparator branches on. */
function grid() {
  /** @type {import('../src/common/order.js').OrderEntry[]} */
  const entries = [];
  for (const neverReviewed of [false, true]) {
    for (const newActivity of [false, true]) {
      for (const triage of [null, 'awaiting reporter']) {
        for (const embargoOverdue of [false, true]) {
          for (const score of [
            { severity: null, severityConfirmed: false },
            { severity: 'critical', severityConfirmed: false },
            { severity: 'low', severityConfirmed: true },
          ]) {
            for (const waitingSince of [null, '2026-01-01T00:00:00Z', '2026-08-01T00:00:00Z']) {
              const id = `GHSA-0000-0000-${String(entries.length).padStart(4, '0')}`;
              entries.push(
                entry(id, {
                  neverReviewed,
                  newActivity,
                  triage,
                  embargoOverdue,
                  waitingSince,
                  ...score,
                })
              );
            }
          }
        }
      }
    }
  }
  return entries;
}

test('the comparator is a total order', () => {
  const entries = grid();
  assert.strictEqual(entries.length, 144);

  // Transitivity is read off a witness rather than off every triple. `place`
  // numbers one sequence of the entries, and a comparator that agrees with that
  // numbering on every pair is the order of the integers read through a
  // relabelling, which carries through. A comparator that does not carry
  // through admits no such sequence at all, so whichever sequence the sort
  // arrived at, some pair disagrees with it.
  /** @type {Map<import('../src/common/order.js').OrderEntry, number>} */
  const place = new Map();
  order.sort(entries).forEach((each, index) => place.set(each, index));
  assert.strictEqual(place.size, entries.length, 'the sorted list dropped an entry');

  for (const a of entries) {
    assert.ok(order.compare(a, a) === 0, `${a.ghsaId} against itself`);
    for (const b of entries) {
      const forward = Math.sign(order.compare(a, b));
      const back = Math.sign(order.compare(b, a));
      assert.ok(forward === -back, `${a.ghsaId} and ${b.ghsaId} disagree on which comes first`);
      if (a !== b) {
        assert.ok(forward !== 0, `${a.ghsaId} and ${b.ghsaId} are distinct but tie`);
        assert.strictEqual(
          forward,
          Math.sign(Number(place.get(a)) - Number(place.get(b))),
          `${a.ghsaId} and ${b.ghsaId} do not order the way one sequence holds them`
        );
      }
    }
  }
});

test('the answer does not depend on the order the entries arrived in', () => {
  const entries = grid();
  const wanted = order.sort(entries).map((each) => each.ghsaId ?? '');
  let seed = 12345;
  for (let round = 0; round < 20; round += 1) {
    const shuffled = entries.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      const swap = /** @type {import('../src/common/order.js').OrderEntry} */ (shuffled[i]);
      shuffled[i] = /** @type {import('../src/common/order.js').OrderEntry} */ (shuffled[j]);
      shuffled[j] = swap;
    }
    ordersAs(shuffled, wanted, `shuffle ${round}`);
  }
});

test('an advisory whose identifier went unread sorts below one that has an identifier', () => {
  // The identifier is the last tie-break, so the two are alike in every key
  // above it and nothing else decides. Reading a null identifier as the empty
  // string puts the row nobody can open at the top of the queue.
  const unread = entry('GHSA-aaaa-aaaa-aaaa', { ghsaId: null, triage: 'evaluating' });
  const known = entry('GHSA-aaaa-aaaa-aaaa', { triage: 'evaluating' });
  assert.ok(order.compare(unread, known) > 0, 'the unread identifier did not sort second');
  assert.ok(order.compare(known, unread) < 0, 'the pair does not order the same way both ways round');
  const sorted = order.sort([unread, known]);
  assert.ok(sorted[0] === known, 'the advisory carrying an identifier belongs first');
  assert.ok(sorted[1] === unread, 'the advisory carrying none belongs last');
});

test('the table sorts on the comparators this file holds', () => {
  // `src/list/table.js` had its own pair, and its text comparator ordered a null
  // the opposite way to the tie-break here.
  assert.strictEqual(order.compareText(null, 'GHSA-aaaa-aaaa-aaaa'), 1);
  assert.strictEqual(order.compareText('GHSA-aaaa-aaaa-aaaa', null), -1);
  assert.strictEqual(order.compareText(null, null), 0);
  assert.strictEqual(order.compareNumber(null, 1), 1);
  assert.strictEqual(order.compareNumber(1, null), -1);
  assert.strictEqual(order.compareNumber(null, null), 0);
});

test('sorting leaves the array it was given alone', () => {
  const entries = [entry('B'), entry('A')];
  order.sort(entries);
  assert.strictEqual(entries[0]?.ghsaId, 'B');
});
