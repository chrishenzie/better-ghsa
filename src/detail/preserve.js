'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/allowlist.js');
  require('../common/schema.js');
  require('../common/parse-detail.js');
  require('../common/write.js');
}

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
 * @typedef {object} Availability
 * @property {boolean} available Whether the button is offered.
 * @property {boolean} writable Whether pressing it would write.
 * @property {string | null} reason One of `preserved`, `attempted`,
 *   `in-flight`, `allowlist`, `provenance`, `unreadable`, and null when the
 *   write is open. `in-flight` is the reason the state write reports for the
 *   same event, so a press and a save landing on a write already going out read
 *   the same to anything that branches on it.
 * @property {string} message What the panel says about it.
 * @property {string | null} href Where the comment holding the original report
 *   is, as a fragment naming it on this page, and null where this document
 *   carries no such comment.
 */

/**
 * @typedef {object} PreserveOptions
 * @property {import('../common/write.js').WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 */

(() => {
  /**
   * The summary line of the preservation comment's `details` block. It is prose
   * for the reader: nothing this extension does keys on it, so it can be
   * rewritten without breaking recognition or write verification.
   */
  const PRESERVE_SUMMARY = `Original report preserved by ${globalThis.bghsa.schema.PROJECT_LINK}`;

  /** The label the advisory's title is written under. */
  const TITLE_LABEL = 'Title:';

  /** The label the advisory's description is written under. */
  const DESCRIPTION_LABEL = 'Description:';

  /**
   * What says a comment is a preservation comment. The body carries it once, in
   * a code span under the summary: GitHub's sanitizer strips HTML comments but
   * keeps `code`, so the token is in the rendered document both checks read, and
   * it owes nothing to any sentence. The trailing `1` is the body format, so a
   * later format can be told from this one.
   *
   * A reporter can copy this token into their own description, which hides the
   * button on their own advisory. That denies the feature on that advisory and
   * writes nothing, so recognition fails safe. Write verification does not rest
   * on it; see `newMarker`.
   */
  const MARKER_PREFIX = 'better-ghsa:preserved:1:';

  /** How many random bytes a marker's per-write value carries. */
  const MARKER_BYTES = 8;

  /**
   * The marker for one press: the fixed prefix and a value drawn immediately
   * before the body is built. The response counts as the write only where it
   * renders this value, which no description written earlier can hold, so text
   * the reporter controls cannot confirm a write that did not happen.
   *
   * @returns {string}
   */
  function newMarker() {
    const bytes = new Uint8Array(MARKER_BYTES);
    globalThis.crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${MARKER_PREFIX}${value}`;
  }

  /**
   * What the panel says while a press is on its way to GitHub. The button that
   * started it is disabled until it settles, so this is the state of a disabled
   * control and not a refusal a press can reach.
   */
  const PENDING_MESSAGE = globalThis.bghsa.write.SAVING_MESSAGE;

  /**
   * What the panel says once a press has gone out unconfirmed. No second press
   * goes out: a duplicate preservation comment is visible to the reporter, and
   * only a fresh read of the page says whether the first one landed.
   */
  const ATTEMPTED_MESSAGE = 'Reload page';

  /**
   * What the panel's Original report row reads once the comment is on the
   * advisory. It is a link where the page carries the comment's anchor and plain
   * text where it does not, and it reads the same either way.
   */
  const PRESERVED_MESSAGE = 'Preserved';

  /** What refuses a press on a page that did not say which advisory it is. */
  const UNREADABLE_REF_MESSAGE =
    'Error: this extension could not read which repository this advisory is in.';

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
   * The comment holding the original report. The marker is what says so; the
   * body is not parsed and no sentence in it is read.
   *
   * @param {readonly ParsedComment[]} comments
   * @returns {ParsedComment | null}
   */
  function preservationComment(comments) {
    return comments.find((comment) => comment.text.includes(MARKER_PREFIX)) ?? null;
  }

  /**
   * Whether the advisory already carries a preservation comment.
   *
   * @param {readonly ParsedComment[]} comments
   * @returns {boolean}
   */
  function hasPreservationComment(comments) {
    return preservationComment(comments) !== null;
  }

  /**
   * Reporter text with every `</details>` that closes nothing taken out. Such a
   * tag would close the block this comment wraps the report in and spill the
   * rest of the report into the thread. A `</details>` that closes a `<details>`
   * the reporter opened stays, and the pair renders as a block nested inside the
   * enclosing one.
   *
   * The tags are counted where they stand in the text, with no reading of how
   * GitHub would render them. A `</details>` shown inside a code sample counts
   * like any other: it can be dropped out of the sample, and it can take the
   * count of an opener, leaving a tag that does close the wrapper in place. That
   * is the accepted cost of not modelling GitHub's renderer.
   *
   * @param {string} text
   * @returns {string}
   */
  function balanceDetails(text) {
    let depth = 0;
    return text.replace(/<details(\s[^>]*)?>|<\/details\s*>/gi, (tag) => {
      if (tag[1] === '/') {
        if (depth === 0) return '';
        depth -= 1;
        return tag;
      }
      depth += 1;
      return tag;
    });
  }

  /**
   * The comment the button writes: one collapsed block holding the marker and
   * then the advisory's title and description under their labels.
   *
   * The marker comes first, immediately under the summary, so that no reporter
   * text can render above it or swallow it.
   *
   * The block's own tags each stand on a line with a blank line between them and
   * what they wrap, which is the shape the summary's link is known to render in.
   *
   * A description whose provenance did not read builds nothing. The comment no
   * longer says which case it is, and the extension still declines to write
   * where it cannot tell whether the description is the reporter's own text.
   *
   * @param {ParsedDetail} advisory
   * @param {string} marker The marker for this press.
   * @returns {string | null} null when the title, the description, or the
   *   description's provenance is not in hand.
   */
  function buildBody(advisory, marker) {
    const { title, description, descriptionOriginal } = advisory;
    if (title === null || description === null || descriptionOriginal === null) return null;
    return globalThis.bghsa.write.detailsBody(PRESERVE_SUMMARY, marker, [
      TITLE_LABEL,
      '',
      balanceDetails(title),
      '',
      DESCRIPTION_LABEL,
      '',
      balanceDetails(description),
    ]);
  }

  /**
   * @param {boolean} available
   * @param {boolean} writable
   * @param {string | null} reason
   * @param {string} message
   * @param {string | null} [href]
   * @returns {Availability}
   */
  function availability(available, writable, reason, message, href = null) {
    return { available, writable, reason, message, href };
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
    const held = preservationComment(advisory.comments);
    if (held !== null) {
      // The comment's own element carries the anchor GitHub links it by, so the
      // panel can point at it and say nothing else.
      return availability(
        false,
        false,
        'preserved',
        PRESERVED_MESSAGE,
        `#${held.elementId}`
      );
    }
    const ref = advisory.ref;
    if (ref === null) {
      return availability(
        true,
        false,
        'unreadable',
        UNREADABLE_REF_MESSAGE
      );
    }
    const nameWithOwner = `${ref.owner}/${ref.repo}`;
    if (!globalThis.bghsa.allowlist.isAllowed(nameWithOwner)) {
      return availability(
        true,
        false,
        'allowlist',
        globalThis.bghsa.write.allowlistMessage(nameWithOwner)
      );
    }
    if (advisory.descriptionOriginal === null) {
      return availability(
        true,
        false,
        'provenance',
        'Error: this extension could not tell whether the description is' +
          " the reporter's original text."
      );
    }
    if (advisory.title === null || advisory.description === null) {
      return availability(true, false, 'unreadable', 'Error: failed to parse advisory');
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
    const attempt = attempts.get(globalThis.bghsa.write.holdKey(ref));
    if (attempt === 'written') {
      return availability(false, false, 'preserved', PRESERVED_MESSAGE);
    }
    if (attempt === 'sent') return availability(false, false, 'attempted', ATTEMPTED_MESSAGE);
    if (attempt === 'pending') return availability(false, false, 'in-flight', PENDING_MESSAGE);
    return state;
  }

  /**
   * Whether a press from this page put a comment on the advisory that this
   * document does not show. A press that reached GitHub may have created the
   * comment whatever came back, so it counts from the moment it went out until
   * the page is read again.
   *
   * @param {ParsedDetail} advisory
   * @returns {boolean}
   */
  function ahead(advisory) {
    const ref = advisory.ref;
    if (ref === null) return false;
    const attempt = attempts.get(globalThis.bghsa.write.holdKey(ref));
    if (attempt !== 'sent' && attempt !== 'written') return false;
    return !hasPreservationComment(advisory.comments);
  }

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
   * and description the comment holds all come from that document, so the
   * comment holds the report as it stood when it was written.
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

    const send =
      options?.fetch ??
      /** @type {import('../common/write.js').WriteFetch} */ (globalThis.fetch.bind(globalThis));
    const toDocument =
      options?.parseDocument ?? ((html) => new DOMParser().parseFromString(html, 'text/html'));

    const { outcome } = await globalThis.bghsa.write.runWrite({
      ref: advisory.ref,
      unreadable: { reason: 'unreadable', message: UNREADABLE_REF_MESSAGE },
      fetch: send,
      parseDocument: toDocument,
      // A press that reached GitHub is never released: GitHub does not put the
      // new comment on the page, so nothing here can say whether it landed, and
      // a second press would put a second permanent comment on a real report.
      hold: {
        // Held before anything is awaited: while a press is in flight the page
        // still shows no comment, and a second press would write a second one.
        take: (key) => {
          attempts.set(key, 'pending');
        },
        sent: (key) => {
          attempts.set(key, 'sent');
        },
        release: (key, settled) => {
          if (settled.outcome?.ok === true) attempts.set(key, 'written');
          // The advisory carries the comment already, written from elsewhere.
          else if (settled.outcome?.reason === 'preserved') attempts.set(key, 'written');
          else if (!settled.sent) attempts.delete(key);
        },
      },
      prepare: (run) => {
        const current = inspect(run.advisory);
        if (!current.writable) return refused(current);
        const marker = newMarker();
        const body = buildBody(run.advisory, marker);
        if (body === null) {
          return failed(
            'unreadable',
            null,
            'Error: this extension could not read what the comment would say.'
          );
        }
        return { body, contains: [marker] };
      },
    });
    return outcome;
  }

  const exported = {
    PRESERVE_SUMMARY,
    attempts,
    TITLE_LABEL,
    DESCRIPTION_LABEL,
    MARKER_PREFIX,
    PENDING_MESSAGE,
    ATTEMPTED_MESSAGE,
    PRESERVED_MESSAGE,
    UNREADABLE_REF_MESSAGE,
    newMarker,
    balanceDetails,
    preservationComment,
    hasPreservationComment,
    buildBody,
    offered,
    ahead,
    preserve,
  };

  globalThis.bghsa.preserve = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
