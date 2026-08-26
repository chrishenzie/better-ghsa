'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const members = require('../src/common/members.js');
const panel = require('../src/detail/panel.js');

const { fakeStorage } = require('../test-support/storage.js');

/** @typedef {import('../test-support/storage.js').FakeStorage} Fake */

/**
 * A storage seeded under the one key this module owns.
 *
 * @param {unknown} [held] What an earlier session left under the members key.
 * @returns {Fake}
 */
const memberStorage = (held) =>
  fakeStorage(held === undefined ? {} : { [members.MEMBERS_KEY]: held });

/**
 * @param {string} name
 * @returns {Document}
 */
function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}
/**
 * @param {Fake} storage
 * @returns {string[]} the logins the entry holds.
 */
function stored(storage) {
  const value = storage.entries[members.MEMBERS_KEY];
  return Array.isArray(value) ? value.map((login) => String(login)) : [];
}

/** @returns {void} takes this session's set and its storage back to empty. */
function forget() {
  members.clear();
  members.setStorage(null);
}

test('a login is held once, spelled as it was first read', () => {
  forget();
  assert.strictEqual(members.remember(['samuelkarp']), true);
  assert.strictEqual(members.remember(['SamuelKarp']), false, 'one account was held twice');
  assert.deepStrictEqual(members.known(), ['samuelkarp']);
  assert.strictEqual(members.isKnown('SAMUELKARP'), true);
  assert.strictEqual(members.isKnown('prakleumas'), false);
});

test('a login with nothing in it is not a member', () => {
  forget();
  assert.strictEqual(members.remember(['', '  ', null, undefined]), false);
  assert.deepStrictEqual(members.known(), []);
});

test('the logins this session read are written to storage', async () => {
  forget();
  const storage = memberStorage();
  members.setStorage(storage);
  members.remember(['samuelkarp', 'dmcgowan']);

  assert.strictEqual(await members.sync(), false, 'storage held a login this session did not');
  assert.deepStrictEqual(stored(storage), ['samuelkarp', 'dmcgowan']);
});

test('the entry accumulates the logins of every session that wrote it', async () => {
  forget();
  const storage = memberStorage(['dmcgowan']);
  members.setStorage(storage);
  members.remember(['samuelkarp']);

  assert.strictEqual(await members.sync(), true, 'a login storage held did not arrive');
  assert.deepStrictEqual(members.known(), ['samuelkarp', 'dmcgowan']);
  assert.deepStrictEqual(stored(storage), ['samuelkarp', 'dmcgowan']);
});

test('a session that adds nothing leaves the entry as it stands', async () => {
  forget();
  const storage = memberStorage(['dmcgowan', 'samuelkarp']);
  members.setStorage(storage);
  members.remember(['SAMUELKARP']);

  assert.strictEqual(await members.sync(), true);
  assert.strictEqual(storage.writes.length, 0, 'the entry was written with nothing new in it');
  assert.deepStrictEqual(members.known(), ['SAMUELKARP', 'dmcgowan']);
});

test('an entry holding something other than logins is read as empty', async () => {
  forget();
  const storage = memberStorage({ samuelkarp: true });
  members.setStorage(storage);
  members.remember(['samuelkarp']);

  assert.strictEqual(await members.sync(), false);
  assert.deepStrictEqual(members.known(), ['samuelkarp']);
  assert.deepStrictEqual(stored(storage), ['samuelkarp'], 'the entry was left unusable');
});

test('storage that fails leaves this session holding what it read', async () => {
  forget();
  members.remember(['samuelkarp']);
  const broken = {
    /** @returns {Promise<Record<string, unknown>>} */
    get: async () => {
      throw new Error('storage is unavailable');
    },
    /** @returns {Promise<void>} */
    set: async () => {
      throw new Error('storage is unavailable');
    },
  };
  members.setStorage(broken);

  assert.strictEqual(await members.sync(), false);
  assert.deepStrictEqual(members.known(), ['samuelkarp']);
});

test('a set that cannot be stored is still held for this page', async () => {
  forget();
  const storage = memberStorage(['dmcgowan']);
  members.setStorage({
    get: storage.get,
    /** @returns {Promise<void>} */
    set: async () => {
      throw new Error('the quota is full');
    },
  });
  members.remember(['samuelkarp']);

  assert.strictEqual(await members.sync(), true);
  assert.deepStrictEqual(members.known(), ['samuelkarp', 'dmcgowan']);
});

test('a page outside a browser stores nothing and reads nothing', async () => {
  forget();
  members.remember(['samuelkarp']);
  assert.strictEqual(members.storageOf(), null, 'this environment offers an extension storage');
  assert.strictEqual(await members.sync(), false);
  assert.deepStrictEqual(members.known(), ['samuelkarp']);
});

test('a render pass holds the members the page shows and stores them', async () => {
  forget();
  const storage = memberStorage();
  members.setStorage(storage);

  const placed = await panel.render(fixture('triage-thread.html'));
  assert.ok(placed !== null, 'the fixture offered no anchor');
  assert.deepStrictEqual(
    members.known(),
    ['samuelkarp'],
    'the pass did not hold the page members before it drew'
  );

  // The pass hands storage the logins on its way out, which settles after the
  // pass itself does.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(stored(storage), ['samuelkarp'], 'the pass stored no member');
  forget();
});
