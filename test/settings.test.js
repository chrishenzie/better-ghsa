'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const allowlist = require('../src/common/allowlist.js');
const settings = require('../src/settings/settings.js');

const { fakeStorage } = require('../test-support/storage.js');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/**
 * The settings page itself, so the ids the script reaches for are the ids the
 * page carries and not a copy of them written here.
 *
 * @returns {{ window: any, document: Document }}
 */
function page() {
  const html = fs.readFileSync(path.join(root, 'src', 'settings', 'settings.html'), 'utf8');
  const { window, document } = parseHTML(html);
  return { window, document: /** @type {Document} */ (/** @type {unknown} */ (document)) };
}

/**
 * A storage seeded with the allowlist and with whatever else the extension has
 * left behind. `remove` is on it because the clear will not use a storage
 * without it, and a stand-in it declines is one no clear could ever reach: an
 * assertion that a key went would then fail for the wrong reason, and one that
 * a key stayed would hold however much was cleared.
 *
 * @param {readonly string[]} [initial] The repositories on the list.
 * @param {Record<string, unknown>} [rest] What else the extension has stored.
 * @returns {import('../test-support/storage.js').FakeStorage}
 */
const memory = (initial, rest) =>
  fakeStorage({
    ...(initial === undefined ? {} : { [allowlist.STORAGE_KEY]: [...initial] }),
    ...(rest ?? {}),
  });

/**
 * @param {Document} doc
 * @returns {string[]} the repositories the page is showing, in the order it
 *   shows them.
 */
function shown(doc) {
  return [...doc.querySelectorAll('#list .row-name')].map((node) => node.textContent ?? '');
}

/**
 * @param {Document} doc
 * @returns {string} the reason the page is showing for refusing an entry, and
 *   empty where it is showing none.
 */
function errorText(doc) {
  const error = doc.getElementById('add-error');
  if (error === null || error.hasAttribute('hidden')) return '';
  return error.textContent ?? '';
}

/**
 * @param {Document} doc
 * @param {string} typed
 * @returns {Promise<boolean>}
 */
async function type(doc, typed) {
  const input = /** @type {HTMLInputElement | null} */ (doc.getElementById('add-input'));
  assert.ok(input !== null, 'the page carries no field to type in');
  input.value = typed;
  return settings.submit(doc);
}

test.afterEach(() => {
  allowlist.setStorage(null);
});

test('the manifest declares the settings page and no background script', () => {
  assert.strictEqual(manifest.options_ui.page, 'src/settings/settings.html');
  // In a tab rather than a popup, because the list is edited rather than read.
  assert.strictEqual(manifest.options_ui.open_in_tab, true);
  // Every surface is a content script, and nothing runs outside a page.
  // REQUIREMENTS.md section 12. Both the key and the file are checked: either
  // one alone leaves the other free to come back and sit there unnoticed.
  assert.ok(!Object.hasOwn(manifest, 'background'), 'the manifest declares a background script');
  assert.ok(
    !fs.existsSync(path.join(root, 'src', 'background.js')),
    'src/background.js is in the tree'
  );
  for (const file of ['src/settings/settings.html', 'src/settings/settings.js'])
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is declared and missing`);
  // The settings page is not a content script and belongs in neither list.
  assert.ok(!manifest.content_scripts[0].js.includes('src/settings/settings.js'));
});

test('the manifest forbids any page from framing the extension pages', () => {
  // The settings page is in `web_accessible_resources` for `https://github.com/*`,
  // which is what lets the button on an off-allowlist advisory page open it. That
  // same listing lets a script on `github.com` put the page in a frame, so the
  // policy denies framing outright. Firefox has enforced `frame-ancestors` on
  // extension pages since 97 (CVE-2022-22761) and Chrome always has; the manifest
  // asks for 128 or later.
  const policy = manifest.content_security_policy.extension_pages;
  assert.match(policy, /frame-ancestors 'none'/);
  // Declaring the key replaces the browser's default, so the default's own
  // protections are restated here: Chrome's `script-src 'self'; object-src 'self';`
  // and Firefox's `script-src 'self'; upgrade-insecure-requests;`. Anything looser
  // in `script-src` would let the page run code it did not ship with.
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /object-src 'self';/);
  assert.match(policy, /upgrade-insecure-requests/);
  for (const loose of ["'unsafe-eval'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'http:', 'https:', '*'])
    assert.ok(!policy.includes(loose), `the policy carries ${loose}`);
});

test('a fresh install shows an empty list and says what to do about it', async () => {
  allowlist.setStorage(memory());
  const { document } = page();
  await settings.start(document);

  assert.deepStrictEqual(shown(document), []);
  const empty = document.getElementById('empty');
  assert.ok(empty?.hasAttribute('hidden') === false, 'nothing said so');
  // On a fresh install this is the only thing on the page explaining why
  // nothing is happening, so it names the next step rather than the absence.
  assert.strictEqual(empty?.textContent?.trim(), 'Add a repository to get started');
});

test('a repository typed into the page is stored and listed', async () => {
  const store = memory();
  allowlist.setStorage(store);
  const { document } = page();
  await settings.start(document);

  assert.strictEqual(await type(document, 'containerd/containerd'), true);
  assert.deepStrictEqual(shown(document), ['containerd/containerd']);
  assert.deepStrictEqual(store.entries[allowlist.STORAGE_KEY], ['containerd/containerd']);
  assert.strictEqual(errorText(document), '');
  assert.strictEqual(document.getElementById('empty')?.hasAttribute('hidden'), true);
  // The field is cleared, so the next repository is typed into an empty one.
  assert.strictEqual(
    /** @type {HTMLInputElement} */ (document.getElementById('add-input')).value,
    ''
  );
});

test('what is not a repository is refused, listed nowhere, and stored nowhere', async () => {
  const store = memory();
  allowlist.setStorage(store);
  const { document } = page();
  await settings.start(document);

  for (const typed of [
    'containerd',
    'containerd/containerd/extra',
    'https://github.com/containerd/containerd',
    'owner name/repo',
    '-owner/repo',
    'owner/repo?ref=main',
  ]) {
    assert.strictEqual(await type(document, typed), false, `accepted ${JSON.stringify(typed)}`);
    assert.strictEqual(
      errorText(document),
      settings.MALFORMED_MESSAGE,
      `said nothing about ${JSON.stringify(typed)}`
    );
    // What was typed stays in the field, so it can be corrected.
    assert.strictEqual(
      /** @type {HTMLInputElement} */ (document.getElementById('add-input')).value,
      typed
    );
  }

  assert.deepStrictEqual(shown(document), []);
  assert.strictEqual(store.writes.length, 0, 'a repository the page refused was stored');
  assert.deepStrictEqual(store.entries, {});

  // A repository the page accepts does store, so the zero above is the refusal
  // and not a count that cannot move.
  assert.strictEqual(await type(document, 'containerd/containerd'), true);
  assert.strictEqual(store.writes.length, 1, 'an accepted repository went unstored');
});

test('an empty field is not an error and stores nothing', async () => {
  const store = memory();
  allowlist.setStorage(store);
  const { document } = page();
  await settings.start(document);

  assert.strictEqual(await type(document, '   '), false);
  assert.strictEqual(errorText(document), '');
  assert.strictEqual(store.writes.length, 0, 'an empty field was stored');

  // A field carrying a repository does store, so the zero above is the empty
  // field and not a count that cannot move.
  assert.strictEqual(await type(document, 'containerd/containerd'), true);
  assert.strictEqual(store.writes.length, 1, 'a filled field went unstored');
});

test('a repository already listed is refused once and listed once', async () => {
  const store = memory(['containerd/containerd']);
  allowlist.setStorage(store);
  const { document } = page();
  await settings.start(document);

  assert.strictEqual(await type(document, 'Containerd/Containerd'), false);
  assert.strictEqual(errorText(document), settings.DUPLICATE_MESSAGE);
  assert.deepStrictEqual(shown(document), ['containerd/containerd']);
  assert.strictEqual(store.writes.length, 0, 'a repository already listed was stored again');

  // A repository the list does not carry does store, so the zero above is the
  // duplicate and not a count that cannot move.
  assert.strictEqual(await type(document, 'containerd/nerdctl'), true);
  assert.strictEqual(store.writes.length, 1, 'a repository not yet listed went unstored');
  assert.deepStrictEqual(shown(document), ['containerd/containerd', 'containerd/nerdctl']);
});

test('pressing Remove takes the repository out of storage and off the page', async () => {
  const store = memory(['containerd/containerd', 'git-utensils/spoon-knife']);
  allowlist.setStorage(store);
  const { window, document } = page();
  await settings.start(document);
  assert.deepStrictEqual(shown(document), ['containerd/containerd', 'git-utensils/spoon-knife']);

  const button = document.querySelector('#list button[data-entry="containerd/containerd"]');
  assert.ok(button !== null, 'the row carries no control that removes it');
  button.dispatchEvent(new window.Event('click', { bubbles: true }));
  // The press reads and writes storage, so the page catches up a turn later.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepStrictEqual(shown(document), ['git-utensils/spoon-knife']);
  assert.deepStrictEqual(store.entries[allowlist.STORAGE_KEY], ['git-utensils/spoon-knife']);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
});

test('submitting the form adds what is typed', async () => {
  // The page is driven through its own control here, which is what proves the
  // control is wired to the code the rest of these tests call directly.
  allowlist.setStorage(memory());
  const { window, document } = page();
  await settings.start(document);

  /** @type {HTMLInputElement} */ (document.getElementById('add-input')).value =
    'containerd/nerdctl';
  const form = document.getElementById('add-form');
  assert.ok(form !== null, 'the page carries no form');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepStrictEqual(shown(document), ['containerd/nerdctl']);
});

test('a list changed elsewhere is redrawn without the page being reloaded', async () => {
  allowlist.setStorage(memory(['containerd/containerd']));
  const { document } = page();
  await settings.start(document);
  assert.deepStrictEqual(shown(document), ['containerd/containerd']);

  await allowlist.save(['git-utensils/spoon-knife']);
  assert.deepStrictEqual(shown(document), ['git-utensils/spoon-knife']);
});
