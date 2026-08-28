'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/**
 * The files the manifest loads into a page, in the order it loads them. Reading
 * the list here rather than repeating it means a surface added to the manifest
 * is covered without anyone remembering to add it.
 *
 * @type {string[]}
 */
const scripts = manifest.content_scripts[0].js;

/** @typedef {{ file: string, id: string, text: string }} Sheet */

/**
 * Every stylesheet the extension puts on a page, taken by letting each surface
 * inject its own onto a document. What comes back is what a page would carry,
 * so a rule this reads is a rule the extension writes and not a copy of one.
 *
 * @returns {Sheet[]}
 */
function stylesheets() {
  /** @type {Sheet[]} */
  const found = [];
  for (const file of scripts) {
    const loaded = require(path.join(root, file));
    if (typeof loaded.ensureStyle !== 'function') continue;
    const doc = /** @type {Document} */ (
      /** @type {unknown} */ (parseHTML('<html><head></head><body></body></html>').document)
    );
    loaded.ensureStyle(doc);
    for (const style of doc.querySelectorAll('style')) {
      found.push({ file, id: style.id, text: style.textContent ?? '' });
    }
  }
  return found;
}

/**
 * @param {string} text A stylesheet.
 * @returns {string[]} every `var()` it holds, each from `var(` through the
 *   parenthesis that closes it, so a fallback carrying parentheses of its own
 *   comes back whole.
 */
function varsIn(text) {
  /** @type {string[]} */
  const found = [];
  for (let at = text.indexOf('var('); at !== -1; at = text.indexOf('var(', at + 4)) {
    let depth = 0;
    let end = -1;
    for (let i = at + 3; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end !== -1, `a var() is never closed: ${text.slice(at, at + 60)}`);
    found.push(text.slice(at, end + 1));
  }
  return found;
}

/**
 * @param {string} expression A `var()`, from `var(` through its closing
 *   parenthesis.
 * @returns {string} what it falls back to when the property it names is not
 *   defined, empty when it names no fallback. The comma that opens a fallback
 *   is the one at the top level: `rgba(1, 2, 3, 0.2)` inside a fallback holds
 *   commas of its own.
 */
function fallbackOf(expression) {
  const inner = expression.slice('var('.length, -1);
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const at = inner[i];
    if (at === '(') depth += 1;
    else if (at === ')') depth -= 1;
    else if (at === ',' && depth === 0) return inner.slice(i + 1).trim();
  }
  return '';
}

test('every var() the extension writes carries a fallback', () => {
  // A theme token the extension names and Primer does not define is invisible
  // to every other test here: linkedom computes no styles, so a declaration
  // that resolves to nothing reads the same as one that resolves. What is
  // readable without an engine is whether the declaration can survive its
  // token going away. A `var()` naming an undefined property with no fallback
  // is invalid at computed-value time and the property takes its unset value,
  // which is how two chips painted from two nonexistent tokens rendered
  // identically. A fallback holds the declaration to a color either way.
  const sheets = stylesheets();
  assert.ok(sheets.length >= 4, `stylesheets found: ${sheets.length}, expected the four surfaces`);
  for (const sheet of sheets) {
    for (const expression of varsIn(sheet.text)) {
      assert.ok(
        fallbackOf(expression) !== '',
        `${sheet.file} writes ${expression} with no fallback`
      );
    }
  }
});
