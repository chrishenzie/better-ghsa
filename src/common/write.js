'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./text.js');
require('./allowlist.js');

/**
 * The response a write reads. `globalThis.fetch` satisfies it, and so does the
 * stand-in a test supplies.
 *
 * @typedef {object} WriteResponse
 * @property {number} status
 * @property {() => Promise<string>} text
 */

/**
 * @typedef {(url: string, init: RequestInit) => Promise<WriteResponse>} WriteFetch
 */

/**
 * @typedef {object} WriteResult
 * @property {boolean} ok
 * @property {string | null} reason One of `allowlist`, `unverifiable`,
 *   `no-form`, `status`, `unwritten`, `unreachable`, and null on success.
 * @property {number | null} status The response status, when there was one.
 * @property {string} message What happened, in the words the panel shows.
 */

/** How every reader here squares up the text a page carries. */
const collapse = globalThis.bghsa.text.collapse;

/**
 * @param {Element} field
 * @returns {string} the value the browser would submit for `field`. The live
 *   property is read where the host offers one, because GitHub fills some
 *   fields after the server rendered them.
 */
function valueOf(field) {
  const live = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (field)).value;
  return typeof live === 'string' ? live : (field.getAttribute('value') ?? '');
}

/**
 * @param {Element} field
 * @returns {boolean} whether a checkbox or radio is checked.
 */
function isChecked(field) {
  const live = /** @type {{ checked?: unknown }} */ (/** @type {unknown} */ (field)).checked;
  return typeof live === 'boolean' ? live : field.hasAttribute('checked');
}

/**
 * @param {Element} field
 * @returns {boolean} whether the form submission leaves `field` out.
 */
function isDisabled(field) {
  return field.hasAttribute('disabled') || field.closest('fieldset[disabled]') !== null;
}

/**
 * @param {Element} select
 * @returns {string[]} the values a submission carries for a `select`.
 */
function selectedValues(select) {
  const options = Array.from(select.querySelectorAll('option'));
  const picked = options.filter((option) => {
    const live = /** @type {{ selected?: unknown }} */ (/** @type {unknown} */ (option)).selected;
    return typeof live === 'boolean' ? live : option.hasAttribute('selected');
  });
  if (select.hasAttribute('multiple')) return picked.map((option) => valueOf(option));
  const one = picked[picked.length - 1] ?? options[0];
  return one === undefined ? [] : [valueOf(one)];
}

/** Input types a form submission never carries a value for. */
const SKIPPED_INPUT_TYPES = ['submit', 'reset', 'button', 'image', 'file'];

/**
 * Every name and value a submission of `form` carries, in document order.
 * Submit buttons are left out: a submission carries only the button that was
 * pressed, and the caller names that one.
 *
 * @param {Element} form
 * @returns {Array<[string, string]>}
 */
function formEntries(form) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  for (const field of form.querySelectorAll('input, textarea, select')) {
    const name = field.getAttribute('name');
    if (name === null || name === '') continue;
    if (isDisabled(field)) continue;
    // A field inside a template or a datalist is not a control of the form.
    if (field.closest('template, datalist') !== null) continue;

    if (field.tagName === 'SELECT') {
      for (const value of selectedValues(field)) entries.push([name, value]);
      continue;
    }
    if (field.tagName === 'INPUT') {
      const type = (field.getAttribute('type') ?? 'text').toLowerCase();
      if (SKIPPED_INPUT_TYPES.includes(type)) continue;
      if (type === 'checkbox' || type === 'radio') {
        if (!isChecked(field)) continue;
        const value = valueOf(field);
        entries.push([name, value === '' ? 'on' : value]);
        continue;
      }
    }
    entries.push([name, valueOf(field)]);
  }
  return entries;
}

/**
 * A copy of what submitting `form` sends. Neither `required_field_XXXX`, which
 * is randomized per render, nor `timestamp_secret`, which is signed, can be
 * constructed, so the write carries the rendered form's own fields and changes
 * only the one field it means to change.
 *
 * The advisory comment forms carry no `enctype`, so a submission of one is
 * `application/x-www-form-urlencoded`, which is what these parameters are.
 *
 * @param {Element} form
 * @returns {URLSearchParams}
 */
function cloneForm(form) {
  const params = new URLSearchParams();
  for (const [name, value] of formEntries(form)) params.append(name, value);
  return params;
}

/**
 * The form that creates a comment on the advisory: the one whose action path
 * ends in `/comments`. An edit form's action ends in the comment's id.
 *
 * @param {Document} root
 * @returns {Element | null}
 */
function findCommentForm(root) {
  for (const form of root.querySelectorAll('form[action]')) {
    const action = form.getAttribute('action') ?? '';
    const path = action.split('#')[0]?.split('?')[0] ?? '';
    if (path.endsWith('/comments')) return form;
  }
  return null;
}

/**
 * Whether `doc` holds `needle` as text. Both roots are read: a document parsed
 * from a fragment carries its content under the document element and leaves
 * the body empty.
 *
 * @param {Document} doc
 * @param {string} needle
 * @returns {boolean}
 */
function documentContains(doc, needle) {
  const wanted = collapse(needle);
  for (const root of [doc.documentElement, doc.body]) {
    if (root === null) continue;
    if (collapse(root.textContent).includes(wanted)) return true;
  }
  return false;
}

/**
 * @typedef {object} CreateCommentOptions
 * @property {Document} doc The page carrying the form the write clones.
 * @property {string} nameWithOwner The repository, as `owner/repo`.
 * @property {string} body The comment's markdown.
 * @property {string} contains Text the response must hold for the write to
 *   count as done.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 */

/**
 * @param {boolean} ok
 * @param {string | null} reason
 * @param {number | null} status
 * @param {string} message
 * @returns {WriteResult}
 */
function result(ok, reason, status, message) {
  return { ok, reason, status, message };
}

/**
 * Creates one comment on the advisory the document shows.
 *
 * The repository is checked before anything else, so a repository off the
 * allowlist never reaches a request. A write whose result cannot be confirmed
 * is reported as failed, because the comment it would leave is permanent and
 * visible to the reporter.
 *
 * @param {CreateCommentOptions} options
 * @returns {Promise<WriteResult>}
 */
async function createComment(options) {
  const { doc, nameWithOwner, body, contains } = options;

  if (!globalThis.bghsa.allowlist.isAllowed(nameWithOwner)) {
    return result(
      false,
      'allowlist',
      null,
      `Nothing was written: ${nameWithOwner} is not on this extension's allowlist.`
    );
  }
  if (collapse(body) === '') {
    return result(false, 'unverifiable', null, 'Nothing was written: the comment is empty.');
  }
  if (collapse(contains) === '') {
    return result(
      false,
      'unverifiable',
      null,
      'Nothing was written: this extension has no way to confirm the write.'
    );
  }

  const form = findCommentForm(doc);
  if (form === null) {
    return result(
      false,
      'no-form',
      null,
      'Nothing was written: this page carries no comment form.'
    );
  }
  const action = form.getAttribute('action') ?? '';

  const params = cloneForm(form);
  params.set('body', body);
  // The action the Comment button performs. It carries `disabled` while the
  // comment field is empty, which is the state of the page under the panel.
  const submit = form.querySelector('button[type="submit"][name="comment"]');
  if (submit !== null) params.set('comment', submit.getAttribute('value') ?? '1');

  const send = options.fetch ?? /** @type {WriteFetch} */ (globalThis.fetch.bind(globalThis));
  /** @type {WriteResponse} */
  let response;
  try {
    response = await send(action, {
      method: 'POST',
      body: params,
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    });
  } catch (error) {
    return result(false, 'unreachable', null, `The write failed: ${String(error)}`);
  }

  const status = response.status;
  if (!(status >= 200 && status < 300)) {
    return result(false, 'status', status, `The write failed: GitHub answered ${status}.`);
  }

  const toDocument =
    options.parseDocument ??
    ((html) => new DOMParser().parseFromString(html, 'text/html'));
  let written = false;
  try {
    written = documentContains(toDocument(await response.text()), contains);
  } catch (error) {
    return result(false, 'unwritten', status, `The write could not be confirmed: ${String(error)}`);
  }
  if (!written) {
    return result(
      false,
      'unwritten',
      status,
      'The write could not be confirmed: GitHub answered without the comment.'
    );
  }
  return result(true, null, status, 'The comment was written.');
}

globalThis.bghsa.write = {
  formEntries,
  cloneForm,
  findCommentForm,
  documentContains,
  createComment,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.write;
}
