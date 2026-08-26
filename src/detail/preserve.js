'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/allowlist.js');
  require('../common/parse-detail.js');
  require('../common/write.js');
}

/**
 * The summary text of the preservation comment's `details` block. It is fixed,
 * so a preservation comment is recognized by it without the body being parsed.
 */
const PRESERVE_SUMMARY = 'Original report preserved by Better GHSA';

/** What the comment says about a title. */
const TITLE_NOTE =
  'The title below is the advisory title as it stood when this comment was' +
  ' written, because GitHub records no revision signal for a title.';

/** What the comment says about a description that has never been revised. */
const ORIGINAL_NOTE =
  "The description below is the reporter's original text: the advisory" +
  ' description carried no revision when this comment was written.';

/** What the comment says about a description that has been revised. */
const REVISED_NOTE =
  'The description below is the text as it stood when this comment was' +
  ' written. The advisory description has been revised since it was reported.';

/** What the panel says while a press is on its way to GitHub. */
const PENDING_MESSAGE = 'A press is already on its way to GitHub for this advisory.';

/** What the panel says once a press has gone out unconfirmed. */
const ATTEMPTED_MESSAGE =
  'A press has already gone to GitHub for this advisory. Reload the page to see' +
  ' whether the comment was created.';

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/parse-detail.js').ParsedComment} ParsedComment
 * @typedef {import('../common/parse-detail.js').AdvisoryRef} AdvisoryRef
 * @typedef {import('../common/write.js').WriteResult} WriteResult
 */

/**
 * How far a press on one advisory has got. `pending` is set before anything is
 * awaited and holds the advisory for the flight; `sent` is a request that went
 * out without a confirmed answer; `written` is a comment this extension
 * confirmed.
 *
 * @typedef {'pending' | 'sent' | 'written'} AttemptState
 */

/**
 * How far a press has got on each advisory, by `owner/repo/GHSA-id`. GitHub
 * does not put the new comment on the page, so the document alone does not say
 * that a press already happened, and a panel rebuilt after GitHub replaced the
 * region it sits in would offer the button a second time.
 *
 * @type {Map<string, AttemptState>}
 */
const attempts = new Map();

/**
 * @param {AdvisoryRef} ref
 * @returns {string} the key an advisory's attempt is held under.
 */
function attemptKey(ref) {
  return `${ref.owner}/${ref.repo}/${ref.ghsaId}`;
}

/**
 * @param {AdvisoryRef} left
 * @param {AdvisoryRef} right
 * @returns {boolean} whether both name the same advisory.
 */
function sameRef(left, right) {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.ghsaId.toLowerCase() === right.ghsaId.toLowerCase()
  );
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
 * Reporter text with every `</details>` that closes nothing taken out. Such a
 * tag would close the block this comment wraps the report in and spill the
 * rest of the report into the thread. A `</details>` that closes a `<details>`
 * the reporter opened stays, and the pair renders as a block nested inside the
 * enclosing one.
 *
 * A tag inside a fenced block or a code span closes nothing when GitHub
 * renders it, so it is left where the reporter put it.
 *
 * @param {string} text
 * @returns {string}
 */
function balanceDetails(text) {
  let depth = 0;

  /**
   * @param {string} line
   * @returns {string} `line` with its unmatched closing tags removed.
   */
  function scan(line) {
    let out = '';
    let at = 0;
    while (at < line.length) {
      const rest = line.slice(at);
      const ticks = /^`+/.exec(rest);
      if (ticks !== null) {
        const run = ticks[0];
        const close = line.indexOf(run, at + run.length);
        const end = close === -1 ? line.length : close + run.length;
        out += line.slice(at, end);
        at = end;
        continue;
      }
      if (rest.startsWith('<')) {
        const opener = /^<details(\s[^>]*)?>/i.exec(rest);
        if (opener !== null) {
          depth += 1;
          out += opener[0];
          at += opener[0].length;
          continue;
        }
        const closer = /^<\/details\s*>/i.exec(rest);
        if (closer !== null) {
          if (depth > 0) {
            depth -= 1;
            out += closer[0];
          }
          at += closer[0].length;
          continue;
        }
      }
      out += rest[0];
      at += 1;
    }
    return out;
  }

  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  const lines = text.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== null) {
      if (
        marker !== null &&
        /** @type {string} */ (marker[1])[0] === fence.char &&
        /** @type {string} */ (marker[1]).length >= fence.length &&
        /** @type {string} */ (marker[2]).trim() === ''
      ) {
        fence = null;
      }
      return line;
    }
    if (marker !== null) {
      const run = /** @type {string} */ (marker[1]);
      fence = { char: /** @type {string} */ (run[0]), length: run.length };
      return line;
    }
    return scan(line);
  });
  return lines.join('\n');
}

/**
 * The comment the button writes: one collapsed block holding what this
 * extension knows about where the title and description came from, and then
 * the advisory's title and description.
 *
 * This extension's own sentences come first, immediately under the summary, so
 * that no reporter text can render above them or swallow them.
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
    TITLE_NOTE,
    '',
    descriptionOriginal ? ORIGINAL_NOTE : REVISED_NOTE,
    '',
    '---',
    '',
    '**Title**',
    '',
    balanceDetails(title),
    '',
    '**Description**',
    '',
    balanceDetails(description),
    '',
    '</details>',
    '',
  ].join('\n');
}

/**
 * The rendered text the response must carry for a write to count as done: the
 * fixed summary and both sentences this extension wrote under it.
 *
 * @param {ParsedDetail} advisory
 * @returns {string[]}
 */
function writtenText(advisory) {
  return [
    PRESERVE_SUMMARY,
    TITLE_NOTE,
    advisory.descriptionOriginal ? ORIGINAL_NOTE : REVISED_NOTE,
  ];
}

/**
 * @typedef {object} Availability
 * @property {boolean} available Whether the button is offered.
 * @property {boolean} writable Whether pressing it would write.
 * @property {string | null} reason One of `preserved`, `attempted`, `pending`,
 *   `allowlist`, `provenance`, `unreadable`, and null when the write is open.
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
 * What one document says about writing this comment, read from that document
 * alone. A repository off the allowlist and a description whose provenance did
 * not read leave the button pressable and refuse the press, so the reason
 * reaches the maintainer who pressed it.
 *
 * @param {ParsedDetail} advisory
 * @returns {Availability}
 */
function inspect(advisory) {
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
 * What the button offers on this advisory: what the page says, and what this
 * page's own presses have already done.
 *
 * An advisory that already carries the comment offers no button, because the
 * extension writes one comment per advisory.
 *
 * @param {ParsedDetail} advisory
 * @returns {Availability}
 */
function offered(advisory) {
  const state = inspect(advisory);
  const ref = advisory.ref;
  if (!state.writable || ref === null) return state;
  const attempt = attempts.get(attemptKey(ref));
  if (attempt === 'written') {
    return availability(false, false, 'preserved', 'The original report is preserved.');
  }
  if (attempt === 'sent') return availability(false, false, 'attempted', ATTEMPTED_MESSAGE);
  if (attempt === 'pending') return availability(false, false, 'pending', PENDING_MESSAGE);
  return state;
}

/**
 * @typedef {object} PreserveOptions
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 */

/**
 * @param {AdvisoryRef} ref
 * @returns {string} the advisory detail page a write reads first.
 */
function detailUrl(ref) {
  return `/${ref.owner}/${ref.repo}/security/advisories/${ref.ghsaId}`;
}

/** How the detail page is asked for. */
const DETAIL_INIT = /** @type {RequestInit} */ ({
  method: 'GET',
  credentials: 'same-origin',
  redirect: 'follow',
  cache: 'no-store',
  headers: { Accept: 'text/html' },
});

/**
 * @param {Availability} state
 * @returns {WriteResult}
 */
function refused(state) {
  return { ok: false, reason: state.reason, status: null, message: state.message };
}

/**
 * @param {string} reason
 * @param {number | null} status
 * @param {string} message
 * @returns {WriteResult}
 */
function failed(reason, status, message) {
  return { ok: false, reason, status, message };
}

/**
 * Writes the preservation comment for this advisory.
 *
 * The whole write runs against a document fetched at press time: the comment
 * this advisory may already carry, the form the request clones, and the title
 * and description the comment states all come from that document, so the
 * comment's sentences hold for the moment it was written.
 *
 * The advisory is held from the first press until that write settles, because
 * a second one would put a second permanent comment on a real report.
 *
 * @param {ParsedDetail} advisory The advisory as the panel read it, which is
 *   what says whether the button writes at all.
 * @param {PreserveOptions} [options]
 * @returns {Promise<WriteResult>}
 */
async function preserve(advisory, options) {
  const state = offered(advisory);
  if (!state.writable) return refused(state);
  const ref = /** @type {AdvisoryRef} */ (advisory.ref);
  const key = attemptKey(ref);
  // Held before anything is awaited: while a press is in flight the page still
  // shows no comment, and a second press would write a second one.
  attempts.set(key, 'pending');

  const send =
    options?.fetch ??
    /** @type {import('../common/write.js').WriteFetch} */ (globalThis.fetch.bind(globalThis));
  const toDocument =
    options?.parseDocument ?? ((html) => new DOMParser().parseFromString(html, 'text/html'));

  /** @type {Document} */
  let page;
  try {
    const response = await send(detailUrl(ref), DETAIL_INIT);
    if (!(response.status >= 200 && response.status < 300)) {
      attempts.delete(key);
      return failed(
        'fetch',
        response.status,
        `Nothing was written: GitHub answered ${response.status} for the advisory page.`
      );
    }
    page = toDocument(await response.text());
  } catch (error) {
    attempts.delete(key);
    return failed(
      'fetch',
      null,
      `Nothing was written: the advisory page could not be read: ${String(error)}`
    );
  }

  const fresh = globalThis.bghsa.parseDetail.parseDetail(page);
  if (fresh === null || fresh.ref === null || !sameRef(fresh.ref, ref)) {
    attempts.delete(key);
    return failed(
      'mismatch',
      null,
      `Nothing was written: the page this extension read is not ${ref.owner}/${ref.repo}` +
        ` ${ref.ghsaId}.`
    );
  }

  const current = inspect(fresh);
  if (!current.writable) {
    if (current.reason === 'preserved') attempts.set(key, 'written');
    else attempts.delete(key);
    return refused(current);
  }
  const body = buildBody(fresh);
  if (body === null) {
    attempts.delete(key);
    return failed(
      'unreadable',
      null,
      'Nothing was written: this extension could not read what the comment would say.'
    );
  }

  let sent = false;
  const outcome = await globalThis.bghsa.write.createComment({
    doc: page,
    ref: fresh.ref,
    body,
    contains: writtenText(fresh),
    fetch: send,
    parseDocument: toDocument,
    beforeSend: () => {
      sent = true;
      attempts.set(key, 'sent');
    },
  });
  if (outcome.ok) attempts.set(key, 'written');
  else if (!sent) attempts.delete(key);
  return outcome;
}

globalThis.bghsa.preserve = {
  PRESERVE_SUMMARY,
  attempts,
  TITLE_NOTE,
  ORIGINAL_NOTE,
  REVISED_NOTE,
  PENDING_MESSAGE,
  ATTEMPTED_MESSAGE,
  balanceDetails,
  hasPreservationComment,
  buildBody,
  writtenText,
  detailUrl,
  offered,
  preserve,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.preserve;
}
