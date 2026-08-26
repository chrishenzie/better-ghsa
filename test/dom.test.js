'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHTML } = require('linkedom');

const dom = require('../src/common/dom.js');

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A page carrying one element the surface owns, with the constructor the watcher
 * reaches through the document's view. Two of these tests turn on what the
 * watcher does with a burst that is nothing but the surface's own writing, so
 * the surface owns the node every mutation here is made on.
 *
 * @returns {{ doc: Document, owned: Element }}
 */
function page() {
  const { document } = parseHTML(
    '<html><head></head><body><div id="bghsa-owned"></div></body></html>'
  );
  const doc = /** @type {Document} */ (/** @type {unknown} */ (document));
  const owned = doc.getElementById('bghsa-owned');
  if (owned === null) throw new Error('the page carries no owned element');
  return { doc, owned };
}

test("a burst of nothing but the surface's own writing schedules no pass", async () => {
  const { doc, owned } = page();
  let passes = 0;
  const observer = dom.watch(doc, {
    ownedSelector: () => '#bghsa-owned',
    outOfPlace: () => false,
    pass: async () => {
      passes += 1;
    },
  });
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    owned.append(doc.createElement('span'));
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, 0, `the surface's own writing ran ${passes} passes`);
  } finally {
    observer?.disconnect();
  }
});

test('a surface left behind takes a pass on its own writing alone', async () => {
  const { doc, owned } = page();
  let passes = 0;
  const observer = dom.watch(doc, {
    ownedSelector: () => '#bghsa-owned',
    outOfPlace: () => true,
    pass: async () => {
      passes += 1;
    },
  });
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    owned.append(doc.createElement('span'));
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, 1, 'a surface that is out of place was left there');
  } finally {
    observer?.disconnect();
  }
});

test('two bursts inside the delay take one pass between them', async () => {
  const { doc } = page();
  let passes = 0;
  const observer = dom.watch(doc, {
    ownedSelector: () => '#bghsa-owned',
    outOfPlace: () => false,
    pass: async () => {
      passes += 1;
    },
  });
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    doc.body?.append(doc.createElement('span'));
    // Long enough for the watcher to be told about the first change, and short
    // enough that the pass it scheduled has not run yet.
    await delay(1);
    doc.body?.append(doc.createElement('span'));
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, 1, `two changes inside one delay ran ${passes} passes`);
  } finally {
    observer?.disconnect();
  }
});
