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

/** A repository on the allowlist, so the pages below are ones writes reach. */
const REPO = '/git-utensils/Spoon-Knife';

/** A GitHub page the extension has no surface for. */
const PULLS = `${REPO}/pulls`;

const ADVISORY_LIST = `${REPO}/security/advisories`;
const ADVISORY = `${ADVISORY_LIST}/GHSA-1234-5678-9abc`;

/**
 * @param {string} name
 * @returns {string} a fixture's markup. The fixtures are large, so each test
 *   reads only the ones it puts on a page.
 */
function fixture(name) {
  return fs.readFileSync(path.join(root, 'testdata', name), 'utf8');
}

/**
 * The `bghsa` member each file hangs its exports off, by the path the manifest
 * names the file under, read from the declaration in types/bghsa.d.ts.
 *
 * The declaration names a member against a whole path, so the member a file has
 * to leave behind is the one written down for that file. Deriving it from the
 * base name instead let two files in different directories answer for each
 * other: `src/done/stats.js` and a second `stats.js` elsewhere would both look
 * for `bghsa.stats`, and either one loading would satisfy the check for both.
 *
 * @type {Map<string, string>}
 */
const DECLARED = new Map(
  [
    ...fs
      .readFileSync(path.join(root, 'types', 'bghsa.d.ts'), 'utf8')
      .matchAll(/^\s*(\w+): typeof import\('\.\.\/([^']+)'\);$/gm),
  ].map((found) => [String(found[2]), String(found[1])])
);

/**
 * @param {string} file A path the manifest loads, as it writes it.
 * @returns {string} the member that file has to leave behind.
 */
function memberOf(file) {
  const held = DECLARED.get(file);
  if (held === undefined) throw new Error(`types/bghsa.d.ts declares no member for ${file}`);
  return held;
}

/**
 * A stand-in for the one isolated-world global a page's content scripts share.
 * `require` and `module` are absent, which is what a content script gets, so
 * every file takes its browser branch and reaches the others only through
 * `bghsa`.
 *
 * The observer constructor, storage and `fetch` all count what they are asked
 * for, because what the extension must not do on a page it has no surface for
 * is watch it, read for it, or send for it.
 *
 * @param {{ pathname?: string, frame?: string }} [options] The page the
 *   document loaded as: the URL GitHub is showing and the markup in the frame
 *   it replaces on a soft navigation.
 * @returns {Record<string, any>} the sandbox backing the context
 */
function contentScriptScope(options = {}) {
  const pathname = options.pathname ?? ADVISORY;
  const { window, document } = parseHTML(
    '<!doctype html><html><head></head><body><div id="repo-content-turbo-frame">' +
      (options.frame ?? '') +
      '</div></body></html>'
  );

  const counts = { made: 0, connected: 0, reads: 0, requests: 0 };
  const Native = window.MutationObserver;
  /**
   * @param {MutationCallback} callback
   * @returns {object} the observer, counting the connections it is asked for.
   */
  function CountingObserver(callback) {
    counts.made += 1;
    const inner = new Native(callback);
    return {
      /**
       * @param {Node} target
       * @param {MutationObserverInit} [init]
       * @returns {void}
       */
      observe(target, init) {
        counts.connected += 1;
        inner.observe(target, init);
      },
      disconnect: () => inner.disconnect(),
      takeRecords: () => inner.takeRecords(),
    };
  }

  const quiet = () => {};
  /** @type {Record<string, any>} */
  const sandbox = {
    document,
    window,
    MutationObserver: CountingObserver,
    location: { pathname, href: `https://github.com${pathname}` },
    browser: {
      storage: {
        local: {
          get: async () => {
            counts.reads += 1;
            return {};
          },
          set: async () => {},
        },
      },
    },
    console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
    // The page's own timers are held unreferenced. A pass still waiting on the
    // request that never settles has one pending when the last assertion runs,
    // and a referenced timer would keep the test process alive after it.
    /**
     * @param {(...args: any[]) => void} fn
     * @param {number} [ms]
     * @returns {unknown}
     */
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout,
    crypto,
    TextEncoder,
    TextDecoder,
    // Never settles, so a page-load fetch neither succeeds nor rejects.
    fetch: () => {
      counts.requests += 1;
      return new Promise(() => {});
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.counts = counts;
  vm.createContext(sandbox);
  return sandbox;
}

/**
 * @param {Record<string, any>} sandbox
 * @returns {string[]} what went wrong loading the manifest's files into this
 *   scope, and empty when every one of them loaded and left its exports behind.
 */
function loadScripts(sandbox) {
  /** @type {string[]} */
  const failures = [];
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
  return failures;
}

/**
 * @param {Record<string, any>} sandbox
 * @returns {string[]} the extension's own names on the page, deduplicated and
 *   sorted. Everything it writes is named `bghsa` something, in an id, a class
 *   or an attribute, so this finds a surface, a stylesheet and a chip alike
 *   without naming each one, and says which it found.
 */
function names(sandbox) {
  const html = sandbox.document.documentElement.outerHTML;
  return [...new Set(html.match(/bghsa[a-z-]*/g) ?? [])].sort();
}

/**
 * GitHub replacing the frame: new markup inside it, a new URL, and the event
 * its framework fires inside the frame once the page is there.
 *
 * @param {Record<string, any>} sandbox
 * @param {{ pathname?: string, frame?: string }} to
 * @returns {void}
 */
function navigate(sandbox, to) {
  const frame = sandbox.document.getElementById('repo-content-turbo-frame');
  assert.ok(frame !== null, 'the page carries no frame to replace');
  if (to.frame !== undefined) frame.innerHTML = to.frame;
  if (to.pathname !== undefined) {
    sandbox.location.pathname = to.pathname;
    sandbox.location.href = `https://github.com${to.pathname}`;
  }
  const name = sandbox.bghsa.content.FRAME_EVENTS[0];
  frame.dispatchEvent(new sandbox.window.Event(name, { bubbles: true }));
}

/**
 * @param {number} [turns] How many turns of the event loop to give the page.
 * @returns {Promise<void>} settled once the work a pass started has run.
 */
async function settle(turns = 40) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('every manifest content script loads in one shared scope', async () => {
  /** @type {string[]} */
  const rejections = [];

  /** @type {(reason: unknown) => void} */
  const onRejection = (reason) => {
    rejections.push(`rejected after load: ${reason instanceof Error ? reason.message : reason}`);
  };
  process.prependListener('unhandledRejection', onRejection);

  const sandbox = contentScriptScope();
  let failures;
  try {
    failures = loadScripts(sandbox);
    // The self-running files start asynchronous work. Let it reach the point
    // where a member missing from the shared namespace would reject.
    await settle(4);
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }

  assert.deepStrictEqual([...failures, ...rejections], []);
  assert.deepStrictEqual(Object.keys(sandbox.bghsa).sort(), scripts.map(memberOf).sort());
});

test('every content script is declared under a name of its own', () => {
  // A file the declaration has no line for has no member this check could ask
  // for, and one declared for a file the manifest never loads is a line nothing
  // stands behind.
  assert.deepStrictEqual(
    scripts.filter((file) => !DECLARED.has(file)),
    [],
    'a content script types/bghsa.d.ts declares no member for'
  );
  assert.deepStrictEqual(
    [...DECLARED.keys()].filter((file) => !scripts.includes(file)),
    [],
    'a member declared for a file the manifest does not load'
  );

  // Two files under one member is the collision this check exists to catch:
  // either of them loading would answer for both.
  const names = [...DECLARED.values()];
  assert.deepStrictEqual(
    names.filter((name, at) => names.indexOf(name) !== at),
    [],
    'a member two files are declared under'
  );
});

test('a GitHub page the extension has no surface for is left alone', async () => {
  const sandbox = contentScriptScope({
    pathname: PULLS,
    frame: fixture('select-menu.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  assert.deepStrictEqual(names(sandbox), [], 'the extension wrote on a page it has no surface for');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
  assert.strictEqual(sandbox.counts.requests, 0, 'a request went out');
});

test('a page that becomes the advisory list gets the table', async () => {
  const sandbox = contentScriptScope({
    pathname: PULLS,
    frame: fixture('select-menu.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface took a pull requests page');

  // The markup on its own is not the signal. GitHub renders an advisory list
  // into the frame on other pages than the advisory list, and the URL is what
  // says which page this is.
  navigate(sandbox, { frame: fixture('list-page-triage.html') });
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface started while the URL still said pulls');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read for a page the URL does not name');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer watched a page the URL does not name');

  navigate(sandbox, { pathname: ADVISORY_LIST });
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    `the table never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
  assert.ok(sandbox.counts.connected > 0, 'the surface started with nothing watching the page');
});

test('a page that becomes an advisory gets the panel', async () => {
  const sandbox = contentScriptScope({
    pathname: PULLS,
    frame: fixture('select-menu.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface took a pull requests page');

  navigate(sandbox, { frame: fixture('published-containerd.html') });
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface started while the URL still said pulls');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read for a page the URL does not name');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer watched a page the URL does not name');

  navigate(sandbox, { pathname: ADVISORY });
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    `the panel never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
  assert.ok(sandbox.counts.connected > 0, 'the surface started with nothing watching the page');
});
