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
 * @property {string | null} reason One of `allowlist`, `fetch`,
 *   `unverifiable`, `no-form`, `no-token`, `mismatch`, `status`, `unwritten`,
 *   `unreachable`, and null on success.
 * @property {number | null} status The response status, when there was one.
 * @property {string} message What happened, in the words the panel shows.
 */

/**
 * @typedef {object} CreateCommentOptions
 * @property {Document} doc The page carrying the form the write clones.
 * @property {import('./parse-detail.js').AdvisoryRef} ref The advisory the
 *   comment goes on, read from that page.
 * @property {string} body The comment's markdown.
 * @property {readonly string[]} contains Text the response must render in one
 *   comment for the write to count as done.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called once the request is built and
 *   before it goes out, so the caller holds the advisory for the flight.
 */

/**
 * @typedef {object} EditCommentOptions
 * @property {Document} doc The page carrying the edit form the write clones.
 * @property {import('./parse-detail.js').AdvisoryRef} ref The advisory the
 *   comment is on, read from that page.
 * @property {string} commentId The comment this edit replaces the body of.
 *   The caller has established that this maintainer wrote it.
 * @property {string} body The comment's new markdown.
 * @property {readonly string[]} contains Text the response must render in one
 *   comment for the write to count as done.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called once the request is built and
 *   before it goes out, so the caller holds the advisory for the flight.
 */

(() => {
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
      if (globalThis.bghsa.parseDetail.isCommentForm(form)) return form;
    }
    return null;
  }

  /**
   * The path the create-comment form of one advisory posts to.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @returns {string}
   */
  function commentPath(ref) {
    return `/${ref.owner}/${ref.repo}/security/advisories/${ref.ghsaId}/comments`;
  }

  /**
   * The path the form that edits one comment posts to.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} commentId
   * @returns {string}
   */
  function editPath(ref, commentId) {
    return `${commentPath(ref)}/${commentId}`;
  }

  /**
   * Whether a form action posts to the advisory the reference names. The
   * allowlist gates on the reference read from the page, so the request target
   * carries the same owner, repository, and advisory id, on `github.com`, and
   * names no credentials. An action this cannot resolve to that one path is
   * refused.
   *
   * @param {string} action
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} [commentId] The comment the action has to name. Without it
   *   the action has to name the advisory's comment collection.
   * @returns {boolean}
   */
  function actionMatchesRef(action, ref, commentId) {
    /** @type {URL} */
    let url;
    try {
      url = new URL(action, 'https://github.com/');
    } catch {
      return false;
    }
    if (url.origin !== 'https://github.com') return false;
    // `origin` drops userinfo, so `https://user:pass@github.com/...` reads as
    // github.com here and is a request this extension does not send.
    if (url.username !== '' || url.password !== '') return false;
    const wanted = commentId === undefined ? commentPath(ref) : editPath(ref, commentId);
    return url.pathname.replace(/\/+$/, '').toLowerCase() === wanted.toLowerCase();
  }

  /**
   * The form that edits one comment. GitHub renders it into the document before
   * any menu is opened, so it is in a page this extension fetched and never
   * displayed.
   *
   * Its presence says nothing about who wrote the comment: a maintainer with
   * write access on the repository gets an edit form for everyone's comments.
   * The caller decides whose comment it may post.
   *
   * @param {Document} root
   * @param {string} commentId
   * @returns {Element | null}
   */
  function findEditForm(root, commentId) {
    return root.querySelector(`form[id="advisory-comment-${commentId}-edit-form"]`);
  }

  /** Elements whose text a reader of the page never sees as comment content. */
  const NOT_RENDERED = [
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'BUTTON',
    'TEMPLATE',
    'SCRIPT',
    'STYLE',
  ];

  /** The elements GitHub renders a comment's markdown into. */
  const COMMENT_BODY = '.comment-body, .js-comment-body, .markdown-body';

  /**
   * The text of `node` as a reader sees it: the content of a form field is the
   * value of a control, not rendered comment content, and is left out.
   *
   * @param {Node} node
   * @returns {string}
   */
  function renderedText(node) {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = /** @type {Element} */ (node);
    if (NOT_RENDERED.includes(element.tagName)) return '';
    let text = '';
    for (const child of element.childNodes) text += renderedText(child);
    return text;
  }

  /**
   * Whether `doc` renders one comment holding every one of `needles`. Both roots
   * are read: a document parsed from a fragment carries its content under the
   * document element and leaves the body empty.
   *
   * A response that echoes a rejected body back into the comment box holds what
   * was written as the value of a control, and an advisory whose own description
   * quotes one of these strings holds it somewhere else on the page. One
   * rendered comment carrying all of them is the write.
   *
   * @param {Document} doc
   * @param {readonly string[]} needles
   * @returns {boolean}
   */
  function commentContains(doc, needles) {
    const wanted = needles.map((needle) => collapse(needle)).filter((needle) => needle !== '');
    if (wanted.length === 0) return false;

    /** @type {Set<Element>} */
    const bodies = new Set();
    for (const root of [doc.documentElement, doc.body]) {
      if (root === null) continue;
      if (root.matches(COMMENT_BODY)) bodies.add(root);
      for (const body of root.querySelectorAll(COMMENT_BODY)) bodies.add(body);
    }

    for (const body of bodies) {
      const text = collapse(renderedText(body));
      if (wanted.every((needle) => text.includes(needle))) return true;
    }
    return false;
  }

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
   * The advisory detail page a write reads before it builds anything.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @returns {string}
   */
  function detailUrl(ref) {
    return `/${ref.owner}/${ref.repo}/security/advisories/${ref.ghsaId}`;
  }

  /** How that page is asked for. */
  const DETAIL_INIT = /** @type {RequestInit} */ ({
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'follow',
    cache: 'no-store',
    headers: { Accept: 'text/html' },
  });

  /**
   * Reads the advisory page the rest of a write runs against: the state it
   * merges, the form it clones, and the text it writes all come from this one
   * document, fetched at the moment the write was asked for.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {{ fetch?: WriteFetch, parseDocument?: (html: string) => Document }} options
   * @returns {Promise<{ page: Document | null, failure: WriteResult | null }>}
   *   exactly one of the two.
   */
  async function fetchAdvisoryPage(ref, options) {
    const send = options.fetch ?? /** @type {WriteFetch} */ (globalThis.fetch.bind(globalThis));
    const toDocument =
      options.parseDocument ?? ((html) => new DOMParser().parseFromString(html, 'text/html'));
    try {
      const response = await send(detailUrl(ref), DETAIL_INIT);
      if (!(response.status >= 200 && response.status < 300)) {
        return {
          page: null,
          failure: result(
            false,
            'fetch',
            response.status,
            `Nothing was written: GitHub answered ${response.status} for the advisory page.`
          ),
        };
      }
      return { page: toDocument(await response.text()), failure: null };
    } catch (error) {
      return {
        page: null,
        failure: result(
          false,
          'fetch',
          null,
          `Nothing was written: the advisory page could not be read: ${String(error)}`
        ),
      };
    }
  }

  /** The field an edit carries the comment's new markdown in. */
  const EDIT_BODY_FIELD = 'repository_advisory_comment[body]';

  /**
   * Fields an edit form has to carry for the request to be one this extension
   * will send. `authenticity_token` is what authorizes the POST, and
   * `repository_advisory_comment[bodyVersion]` is GitHub's optimistic
   * concurrency token for the comment body: without it, an edit would overwrite
   * a body that changed between the fetch and the POST.
   *
   * @type {readonly string[]}
   */
  const REQUIRED_EDIT_FIELDS = [
    'authenticity_token',
    'repository_advisory_comment[bodyVersion]',
    EDIT_BODY_FIELD,
  ];

  /**
   * What refuses a write before any request is built: a repository this
   * extension does not write to, a comment with nothing in it, and a write whose
   * result could not be recognized in GitHub's answer.
   *
   * @param {import('./parse-detail.js').AdvisoryRef} ref
   * @param {string} body
   * @param {readonly string[]} contains
   * @returns {WriteResult | null} null when nothing refuses the write.
   */
  function refuseBeforeRequest(ref, body, contains) {
    const nameWithOwner = `${ref.owner}/${ref.repo}`;
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
    if (contains.every((needle) => collapse(needle) === '')) {
      return result(
        false,
        'unverifiable',
        null,
        'Nothing was written: this extension has no way to confirm the write.'
      );
    }
    return null;
  }

  /**
   * Sends one built request and reads GitHub's answer. A write whose result
   * cannot be confirmed is reported as failed, because the comment it would
   * leave is permanent and visible to the reporter.
   *
   * @param {string} action
   * @param {URLSearchParams} params
   * @param {readonly string[]} contains
   * @param {CreateCommentOptions | EditCommentOptions} options
   * @returns {Promise<WriteResult>}
   */
  async function postForm(action, params, contains, options) {
    const send = options.fetch ?? /** @type {WriteFetch} */ (globalThis.fetch.bind(globalThis));
    /** @type {WriteResponse} */
    let response;
    if (options.beforeSend !== undefined) options.beforeSend();
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
      options.parseDocument ?? ((html) => new DOMParser().parseFromString(html, 'text/html'));
    let written = false;
    try {
      written = commentContains(toDocument(await response.text()), contains);
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

  /**
   * Creates one comment on the advisory the document shows.
   *
   * The repository is checked before anything else, so a repository off the
   * allowlist never reaches a request.
   *
   * @param {CreateCommentOptions} options
   * @returns {Promise<WriteResult>}
   */
  async function createComment(options) {
    const { doc, ref, body, contains } = options;
    const refused = refuseBeforeRequest(ref, body, contains);
    if (refused !== null) return refused;

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
    if (!actionMatchesRef(action, ref)) {
      return result(
        false,
        'mismatch',
        null,
        'Nothing was written: the comment form on this page posts somewhere other than' +
          ` ${ref.owner}/${ref.repo} ${ref.ghsaId}.`
      );
    }

    const params = cloneForm(form);
    params.set('body', body);
    // The action the Comment button performs. It carries `disabled` while the
    // comment field is empty, which is the state of the page under the panel.
    const submit = form.querySelector('button[type="submit"][name="comment"]');
    if (submit !== null) params.set('comment', submit.getAttribute('value') ?? '1');

    return postForm(action, params, contains, options);
  }

  /**
   * Replaces the body of one comment on the advisory the document shows.
   *
   * The clone carries the form's own fields untouched and changes one: the
   * randomized `required_field_XXXX` and the signed `timestamp_secret` cannot be
   * constructed, and `repository_advisory_comment[bodyVersion]` is what makes
   * GitHub reject an edit whose comment changed after the fetch.
   *
   * Which comment this may post to is the caller's decision. The form for
   * another maintainer's comment is in the page too, and posting it would
   * overwrite what that maintainer wrote.
   *
   * @param {EditCommentOptions} options
   * @returns {Promise<WriteResult>}
   */
  async function editComment(options) {
    const { doc, ref, commentId, body, contains } = options;
    const refused = refuseBeforeRequest(ref, body, contains);
    if (refused !== null) return refused;

    const form = findEditForm(doc, commentId);
    if (form === null) {
      return result(
        false,
        'no-form',
        null,
        `Nothing was written: this page carries no edit form for comment ${commentId}.`
      );
    }
    const action = form.getAttribute('action') ?? '';
    if (!actionMatchesRef(action, ref, commentId)) {
      return result(
        false,
        'mismatch',
        null,
        'Nothing was written: the edit form on this page posts somewhere other than' +
          ` ${ref.owner}/${ref.repo} ${ref.ghsaId} comment ${commentId}.`
      );
    }

    const params = cloneForm(form);
    const missing = REQUIRED_EDIT_FIELDS.filter((field) => !params.has(field));
    if (missing.length > 0) {
      return result(
        false,
        'no-token',
        null,
        `Nothing was written: the edit form for comment ${commentId} carries no` +
          ` ${missing.join(' and no ')}.`
      );
    }
    params.set(EDIT_BODY_FIELD, body);

    return postForm(action, params, contains, options);
  }

  const exported = {
    DETAIL_INIT,
    EDIT_BODY_FIELD,
    REQUIRED_EDIT_FIELDS,
    detailUrl,
    fetchAdvisoryPage,
    formEntries,
    cloneForm,
    findCommentForm,
    findEditForm,
    commentPath,
    editPath,
    actionMatchesRef,
    renderedText,
    commentContains,
    createComment,
    editComment,
  };

  globalThis.bghsa.write = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
