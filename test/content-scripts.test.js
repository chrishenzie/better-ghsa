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

/** That repository as the allowlist stores it, and the key it is stored under. */
const ALLOWED = 'git-utensils/spoon-knife';
const ALLOWLIST_KEY = 'allowlist';

/** A GitHub page the extension has no surface for. */
const PULLS = `${REPO}/pulls`;

/** A repository the allowlist does not carry. */
const OTHER = '/another-owner/another-repo';

const OTHER_LIST = `${OTHER}/security/advisories`;
const OTHER_ADVISORY = `${OTHER_LIST}/GHSA-1234-5678-9abc`;

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
 * @param {{ pathname?: string, frame?: string, allowlist?: readonly string[],
 *   holdStorage?: boolean }} [options]
 *   The page the document loaded as: the URL GitHub is showing and the markup in
 *   the frame it replaces on a soft navigation. `allowlist` is what storage
 *   holds for the extension's list of repositories, which is empty on a fresh
 *   install and here defaults to the one the fixtures come from, and
 *   `holdStorage` makes every read hang, which is the page as it stands before
 *   the list has arrived.
 * @returns {Record<string, any>} the sandbox backing the context
 */
function contentScriptScope(options = {}) {
  const pathname = options.pathname ?? ADVISORY;
  const { window, document } = parseHTML(
    '<!doctype html><html><head></head><body><div id="repo-content-turbo-frame">' +
      (options.frame ?? '') +
      '</div></body></html>'
  );

  const counts = { made: 0, connected: 0, reads: 0, requests: 0, writes: 0 };
  /** What storage holds, so a read answers with what a write put there. */
  /** @type {Record<string, unknown>} */
  const stored = {};
  stored[ALLOWLIST_KEY] = [...(options.allowlist ?? [ALLOWED])];
  /** Every key a write has named, in the order they were written. */
  /** @type {string[]} */
  const written = [];
  /**
   * Whoever the extension has asked to hear about a storage change. The browser
   * announces one page of an extension writing to the others, which is how a
   * settings page reaches an advisory page that is already open.
   *
   * @type {((changes: Record<string, { newValue?: unknown }>, area: string) => void)[]}
   */
  const changeListeners = [];
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
    // `remove` is here because the cache will not use a storage without it, and
    // a stand-in the cache declines is one no cache write could ever reach: an
    // assertion that nothing was stored would then hold however much the
    // extension tried to store.
    browser: {
      storage: {
        local: {
          /**
           * @param {string | string[] | null} keys
           * @returns {Promise<Record<string, unknown>>}
           */
          get: async (keys) => {
            if (options.holdStorage === true) return new Promise(() => {});
            // The extension's own list of repositories is not something stored
            // for a repository, and it is read on every github.com page,
            // including the ones the extension goes on to leave alone. The
            // count is of the reads a page costs, so that one is not in it.
            if (keys !== ALLOWLIST_KEY) counts.reads += 1;
            if (keys === null || keys === undefined) return { ...stored };
            /** @type {Record<string, unknown>} */
            const answer = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.hasOwn(stored, key)) answer[key] = stored[key];
            }
            return answer;
          },
          /**
           * @param {Record<string, unknown>} items
           * @returns {Promise<void>}
           */
          set: async (items) => {
            counts.writes += 1;
            for (const [key, value] of Object.entries(items)) {
              stored[key] = value;
              written.push(key);
            }
          },
          /**
           * @param {string | string[]} keys
           * @returns {Promise<void>}
           */
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
          },
        },
        onChanged: {
          /**
           * @param {(changes: Record<string, { newValue?: unknown }>, area: string) => void} fn
           * @returns {void}
           */
          addListener: (fn) => {
            changeListeners.push(fn);
          },
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
  sandbox.written = written;
  sandbox.stored = stored;
  sandbox.changeListeners = changeListeners;
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
 * A maintainer editing the list in the extension's settings, which is another
 * page of this extension writing to the same storage. The page under test hears
 * it the way the browser tells it: a change announcement, not a read.
 *
 * @param {Record<string, any>} sandbox
 * @param {readonly string[]} entries
 * @returns {void}
 */
function setAllowlist(sandbox, entries) {
  const next = [...entries];
  sandbox.stored[ALLOWLIST_KEY] = next;
  for (const listener of [...sandbox.changeListeners]) {
    listener({ [ALLOWLIST_KEY]: { newValue: next } }, 'local');
  }
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
  // The counts the tests above read zero from are counts that move, and the key
  // list they read empty is a list that gets pushed to. A surface that has
  // landed watches the page, reads storage, and stores what it read.
  assert.ok(sandbox.counts.made > 0, 'the surface made no observer');
  assert.ok(sandbox.counts.reads > 0, 'the surface read no storage');
  assert.ok(sandbox.counts.writes > 0, 'the surface stored nothing');
  assert.ok(sandbox.written.length > 0, 'the surface named no key it stored');
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
  // The counts the tests above read zero from are counts that move, and the key
  // list they read empty is a list that gets pushed to. A surface that has
  // landed watches the page, reads storage, and stores what it read.
  assert.ok(sandbox.counts.made > 0, 'the surface made no observer');
  assert.ok(sandbox.counts.reads > 0, 'the surface read no storage');
  assert.ok(sandbox.counts.writes > 0, 'the surface stored nothing');
  assert.ok(sandbox.written.length > 0, 'the surface named no key it stored');
});

test('an advisory on a repository the allowlist does not carry is left alone', async () => {
  const sandbox = contentScriptScope({
    pathname: OTHER_ADVISORY,
    frame: fixture('triage-thread.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  // What is asserted first, because it is what a panel-shaped assertion misses.
  // A surface that drew nothing can still have read the advisory and stored it:
  // the panel holds the advisory it renders, the logins carrying a member
  // badge, and the branches the patches name, and none of those is on the page
  // to be looked for.
  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
  // The page is an advisory and the extension has a surface for it; the
  // repository is the only thing keeping the surface off. REQUIREMENTS.md
  // section 8.
  assert.deepStrictEqual(names(sandbox), [], 'the extension wrote on the page');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');
  assert.strictEqual(sandbox.counts.requests, 0, 'a request went out');
});

test('an advisory list on a repository the allowlist does not carry is left alone', async () => {
  const sandbox = contentScriptScope({
    pathname: OTHER_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  // The list page's own stores, asserted first for the same reason: the parsed
  // list, and the crawl's progress carrying the moment of the last request.
  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
  assert.deepStrictEqual(names(sandbox), [], 'the extension wrote on the page');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');
  assert.strictEqual(sandbox.counts.requests, 0, 'a request went out');
});

test('a page that becomes another repository advisory stores nothing for it', async () => {
  // The surfaces are already running, on a repository the allowlist carries.
  // GitHub then replaces the frame with an advisory somewhere else, which loads
  // no document, so the gate at the start of the page is long past.
  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    'the table never landed on the repository the allowlist carries'
  );

  // Nonzero, so the comparison below rests on a recording this test has seen
  // work: the surface stored what it read for the repository it opened on.
  const before = sandbox.written.length;
  assert.ok(before > 0, 'the surface stored nothing on the repository the allowlist carries');
  navigate(sandbox, { pathname: OTHER_ADVISORY, frame: fixture('triage-thread.html') });
  await settle();

  // The repository the page opened on keeps its refresh going, so what is
  // asserted is what the advisory would have stored: the advisory itself, the
  // logins on it, and the branches its patches name.
  const after = /** @type {string[]} */ (sandbox.written.slice(before));
  assert.deepStrictEqual(
    after.filter(
      (key) => key.startsWith('adv:') || key === 'members' || key === 'branches'
    ),
    [],
    `the advisory was stored: ${after.join(', ')}`
  );
  // Compared as a boolean, because a failure carrying the node itself is a
  // subtree the runner serializes to report it, and that exhausts the heap
  // rather than printing a failure.
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) === null,
    'the panel took an advisory on a repository the allowlist does not carry'
  );
});

test('a page that becomes another repository advisory list stores nothing for it', async () => {
  // The list fixture names the repository it came from throughout, and the
  // surface reads that name off the page, so this stands the same page up under
  // a repository the allowlist does not carry.
  const elsewhere = fixture('list-page-triage.html').replaceAll(
    'git-utensils/Spoon-Knife',
    'another-owner/another-repo'
  );

  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    'the table never landed on the repository the allowlist carries'
  );

  // Nonzero, so the comparison below rests on a recording this test has seen
  // work: the surface stored what it read for the repository it opened on.
  const before = sandbox.written.length;
  assert.ok(before > 0, 'the surface stored nothing on the repository the allowlist carries');
  navigate(sandbox, { pathname: OTHER_LIST, frame: elsewhere });
  await settle();

  const after = /** @type {string[]} */ (sandbox.written.slice(before));
  assert.deepStrictEqual(
    after.filter((key) => key.includes('another-owner/another-repo')),
    [],
    `the list was stored: ${after.join(', ')}`
  );
  assert.strictEqual(sandbox.counts.requests, 0, 'a request went out for it');
});

test('a list with no repositories leaves an advisory alone', async () => {
  // A fresh install stores no list, so this is what every page looks like until
  // a maintainer names a repository in the settings. REQUIREMENTS.md section 12.
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
    allowlist: [],
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
  assert.deepStrictEqual(names(sandbox), [], 'the extension wrote on the page');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');
  assert.strictEqual(sandbox.counts.requests, 0, 'a request went out');
});

test('a list with no repositories leaves an advisory list alone', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
    allowlist: [],
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.strictEqual(sandbox.counts.reads, 0, 'storage was read');
  assert.deepStrictEqual(names(sandbox), [], 'the extension wrote on the page');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');
  assert.strictEqual(sandbox.counts.requests, 0, 'a request went out');
});

test('a repository is matched against the list whatever case either is in', async () => {
  // GitHub serves the repository under the case its owner chose and the
  // maintainer types whichever case they remember, so neither side of the
  // comparison is the one the other was written in.
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
    allowlist: ['GIT-Utensils/Spoon-KNIFE'],
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    `the panel never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
});

test('a repository taken off the list stops the extension on a page showing it', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    'the panel never landed on the repository the list carried'
  );

  // Nonzero, so the comparison below rests on a recording this test has seen
  // work: the surface stored what it read for the repository it opened on.
  const before = sandbox.written.length;
  assert.ok(before > 0, 'the surface stored nothing on the repository the allowlist carries');
  setAllowlist(sandbox, []);
  await settle();

  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) === null,
    'the panel stayed on a repository nobody lists'
  );
  assert.deepStrictEqual(names(sandbox), [], 'the extension left its own writing on the page');
  assert.deepStrictEqual(
    /** @type {string[]} */ (sandbox.written.slice(before)),
    [],
    'the advisory was stored after its repository left the list'
  );
});

test('a repository taken off the list stops the extension on an advisory list', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY_LIST,
    frame: fixture('list-page-triage.html'),
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) !== null,
    'the table never landed on the repository the list carried'
  );

  setAllowlist(sandbox, []);
  await settle();

  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.table.ROOT_ID) === null,
    'the table stayed on a repository nobody lists'
  );
  assert.deepStrictEqual(names(sandbox), [], 'the extension left its own writing on the page');
  // GitHub's own view is what the page had before the table hid it, and it is
  // what the page is left with.
  const container = sandbox.document.querySelector('#advisories');
  assert.ok(container !== null, 'the list page carries no container');
  assert.strictEqual(
    container.querySelectorAll(`.${sandbox.bghsa.table.HIDDEN_CLASS}`).length,
    0,
    "GitHub's own view was left hidden"
  );
});

test('a repository added to the list starts the extension on a page already open', async () => {
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
    allowlist: [],
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();
  assert.deepStrictEqual(names(sandbox), [], 'a surface took a page no list carried');

  setAllowlist(sandbox, [ALLOWED]);
  await settle();

  assert.ok(
    sandbox.document.getElementById(sandbox.bghsa.panel.PANEL_ID) !== null,
    `the panel never landed; the page carries ${names(sandbox).join(', ') || 'nothing'}`
  );
});

test('a page whose list has not arrived yet is left alone', async () => {
  // The gate is synchronous and storage is not, so between the content scripts
  // loading and the read landing there is no answer. Reading no answer as yes
  // would inject and store on a repository nobody listed, so it is read as no,
  // and this holds the read open to prove it.
  const sandbox = contentScriptScope({
    pathname: ADVISORY,
    frame: fixture('triage-thread.html'),
    holdStorage: true,
  });
  assert.deepStrictEqual(loadScripts(sandbox), []);
  await settle();

  // The gate itself, asked while the read is still out. Everything below is
  // what answering it wrongly would cost.
  assert.strictEqual(
    sandbox.bghsa.content.enabled(),
    false,
    'the gate said yes before the list had arrived'
  );
  assert.deepStrictEqual(sandbox.written, [], 'something was stored');
  assert.strictEqual(sandbox.counts.writes, 0, 'storage was written');
  assert.deepStrictEqual(names(sandbox), [], 'the extension wrote on the page');
  assert.strictEqual(sandbox.counts.made, 0, 'an observer was made');
  assert.strictEqual(sandbox.counts.connected, 0, 'an observer was connected');
  assert.strictEqual(sandbox.counts.requests, 0, 'a request went out');
});
