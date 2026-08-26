'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/allowlist.js');
  require('../common/write.js');
}

/**
 * The summary text of the preservation comment's `details` block. It is fixed,
 * so a preservation comment is recognized by it without the body being parsed.
 */
const PRESERVE_SUMMARY = 'Original report preserved by Better GHSA';

/** What the comment says about a title. */
const TITLE_NOTE =
  'The title above is the advisory title as it stood when this comment was' +
  ' written, because GitHub records no revision signal for a title.';

/** What the comment says about a description that has never been revised. */
const ORIGINAL_NOTE =
  "The description above is the reporter's original text: the advisory" +
  ' description carried no revision when this comment was written.';

/** What the comment says about a description that has been revised. */
const REVISED_NOTE =
  'The description above is the text as it stood when this comment was' +
  ' written. The advisory description has been revised since it was reported.';

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/parse-detail.js').ParsedComment} ParsedComment
 * @typedef {import('../common/write.js').WriteResult} WriteResult
 */

/**
 * The advisories a press has already been sent for, by
 * `owner/repo/GHSA-id`, holding whether the write was confirmed. GitHub does
 * not put the new comment on the page, so the document alone does not say that
 * a press already happened, and a panel rebuilt after GitHub replaced the
 * region it sits in would offer the button a second time.
 *
 * @type {Map<string, boolean>}
 */
const attempts = new Map();

/**
 * @param {import('../common/parse-detail.js').AdvisoryRef} ref
 * @returns {string} the key an advisory's attempt is held under.
 */
function attemptKey(ref) {
  return `${ref.owner}/${ref.repo}/${ref.ghsaId}`;
}

/**
 * Whether the advisory already carries a preservation comment. The fixed
 * summary text is what says so; the body is not parsed.
 *
 * @param {readonly ParsedComment[]} comments
 * @returns {boolean}
 */
function hasPreservationComment(comments) {
  return comments.some((comment) => comment.text.includes(PRESERVE_SUMMARY));
}

/**
 * The comment the button writes: one collapsed block holding the advisory's
 * title and description, and what the extension knows about where each came
 * from.
 *
 * @param {ParsedDetail} advisory
 * @returns {string | null} null when a value the comment states is not in
 *   hand, because the comment makes a durable claim in front of the reporter.
 */
function buildBody(advisory) {
  const { title, description, descriptionOriginal } = advisory;
  if (title === null || description === null || descriptionOriginal === null) return null;
  return [
    '<details>',
    `<summary>${PRESERVE_SUMMARY}</summary>`,
    '',
    '**Title**',
    '',
    title,
    '',
    '**Description**',
    '',
    description,
    '',
    '---',
    '',
    TITLE_NOTE,
    '',
    descriptionOriginal ? ORIGINAL_NOTE : REVISED_NOTE,
    '',
    '</details>',
    '',
  ].join('\n');
}

/**
 * @typedef {object} Availability
 * @property {boolean} available Whether the button is offered.
 * @property {boolean} writable Whether pressing it would write.
 * @property {string | null} reason One of `preserved`, `allowlist`,
 *   `provenance`, `unreadable`, and null when the write is open.
 * @property {string} message What the panel says about it.
 */

/**
 * @param {boolean} available
 * @param {boolean} writable
 * @param {string | null} reason
 * @param {string} message
 * @returns {Availability}
 */
function availability(available, writable, reason, message) {
  return { available, writable, reason, message };
}

/**
 * What the button offers on this advisory.
 *
 * An advisory that already carries the comment offers no button, because the
 * extension writes one comment per advisory. A repository off the allowlist
 * and a description whose provenance did not read both leave the button
 * pressable and refuse the press, so the reason reaches the maintainer who
 * pressed it.
 *
 * @param {ParsedDetail} advisory
 * @returns {Availability}
 */
function offered(advisory) {
  if (hasPreservationComment(advisory.comments)) {
    return availability(false, false, 'preserved', 'The original report is already preserved.');
  }
  const ref = advisory.ref;
  if (ref === null) {
    return availability(
      true,
      false,
      'unreadable',
      'Nothing was written: this extension could not read which repository this advisory is in.'
    );
  }
  const attempt = attempts.get(attemptKey(ref));
  if (attempt === true) {
    return availability(false, false, 'preserved', 'The original report is preserved.');
  }
  if (attempt === false) {
    return availability(
      false,
      false,
      'attempted',
      'A press has already gone to GitHub for this advisory. Reload the page to see' +
        ' whether the comment was created.'
    );
  }
  const nameWithOwner = `${ref.owner}/${ref.repo}`;
  if (!globalThis.bghsa.allowlist.isAllowed(nameWithOwner)) {
    return availability(
      true,
      false,
      'allowlist',
      `Nothing was written: ${nameWithOwner} is not on this extension's allowlist.`
    );
  }
  if (advisory.descriptionOriginal === null) {
    return availability(
      true,
      false,
      'provenance',
      'Nothing was written: this extension could not tell whether the description is' +
        " the reporter's original text."
    );
  }
  if (advisory.title === null || advisory.description === null) {
    return availability(
      true,
      false,
      'unreadable',
      'Nothing was written: this extension could not read the advisory title and description.'
    );
  }
  return availability(true, true, null, 'Preserve the title and description in a comment.');
}

/**
 * @typedef {object} PreserveOptions
 * @property {Document} doc The page carrying the comment form.
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 */

/**
 * Writes the preservation comment for this advisory.
 *
 * @param {ParsedDetail} advisory
 * @param {PreserveOptions} options
 * @returns {Promise<WriteResult>}
 */
async function preserve(advisory, options) {
  const state = offered(advisory);
  if (!state.writable) {
    return { ok: false, reason: state.reason, status: null, message: state.message };
  }
  const body = buildBody(advisory);
  if (body === null) {
    return {
      ok: false,
      reason: 'unreadable',
      status: null,
      message: 'Nothing was written: this extension could not read what the comment would say.',
    };
  }
  const ref = /** @type {import('../common/parse-detail.js').AdvisoryRef} */ (advisory.ref);
  const outcome = await globalThis.bghsa.write.createComment({
    doc: options.doc,
    nameWithOwner: `${ref.owner}/${ref.repo}`,
    body,
    contains: PRESERVE_SUMMARY,
    fetch: options.fetch,
    parseDocument: options.parseDocument,
  });
  // A press whose request went out is not offered again in this page's
  // lifetime, whatever came back, because a second one would write a second
  // comment.
  const sent = outcome.ok || outcome.status !== null || outcome.reason === 'unreachable';
  if (sent) attempts.set(attemptKey(ref), outcome.ok);
  return outcome;
}

globalThis.bghsa.preserve = {
  PRESERVE_SUMMARY,
  attempts,
  TITLE_NOTE,
  ORIGINAL_NOTE,
  REVISED_NOTE,
  hasPreservationComment,
  buildBody,
  offered,
  preserve,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.preserve;
}
