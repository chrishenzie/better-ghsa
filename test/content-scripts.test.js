'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/**
 * The files the manifest loads into a page, in the order it loads them. Reading
 * the list here rather than repeating it means a file added to the manifest is
 * covered without anyone remembering to add it.
 *
 * @type {string[]}
 */
const scripts = manifest.content_scripts[0].js;

/**
 * The `bghsa` member a file hangs its exports off: the file's base name with
 * each dashed word capitalized, as types/bghsa.d.ts declares it.
 *
 * @param {string} file
 * @returns {string}
 */
function memberOf(file) {
  return path.basename(file, '.js').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * A stand-in for the one isolated-world global a page's content scripts share.
 * `require` and `module` are absent, which is what a content script gets, so
 * every file takes its browser branch and reaches the others only through
 * `bghsa`.
 *
 * @returns {Record<string, any>} the sandbox backing the context
 */
function contentScriptScope() {
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="repo-content-pjax-container"></div></body></html>'
  );
  const quiet = () => {};
  /** @type {Record<string, any>} */
  const sandbox = {
    document,
    window,
    MutationObserver: window.MutationObserver,
    location: {
      pathname: '/git-utensils/Spoon-Knife/security/advisories/GHSA-1234-5678-9abc',
      href: 'https://github.com/git-utensils/Spoon-Knife/security/advisories/GHSA-1234-5678-9abc',
    },
    browser: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
    setTimeout,
    clearTimeout,
    // Never settles, so a page-load fetch neither succeeds nor rejects.
    fetch: () => new Promise(() => {}),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

test('every manifest content script loads in one shared scope', async () => {
  const failures = [];

  /** @type {(reason: unknown) => void} */
  const onRejection = (reason) => {
    failures.push(`rejected after load: ${reason instanceof Error ? reason.message : reason}`);
  };
  process.prependListener('unhandledRejection', onRejection);

  const sandbox = contentScriptScope();
  try {
    for (const file of scripts) {
      const code = fs.readFileSync(path.join(root, file), 'utf8');
      try {
        // A browser aborts the file that threw and loads the rest, so this
        // reports every file that failed and not only the first.
        vm.runInContext(code, sandbox, { filename: file });
      } catch (error) {
        failures.push(`${file} threw: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      const member = memberOf(file);
      if (sandbox.bghsa === undefined || sandbox.bghsa[member] === undefined) {
        failures.push(`${file} left no bghsa.${member}`);
      }
    }

    // The self-running files start asynchronous work. Let it reach the point
    // where a member missing from the shared namespace would reject.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }

  assert.deepStrictEqual(failures, []);
  assert.deepStrictEqual(Object.keys(sandbox.bghsa).sort(), scripts.map(memberOf).sort());
});
