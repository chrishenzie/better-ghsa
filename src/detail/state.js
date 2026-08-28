'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/allowlist.js');
  require('../common/schema.js');
  require('../common/merge.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
  require('../common/write.js');
  require('../common/members.js');
  require('../common/cache.js');
}

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/parse-detail.js').ParsedComment} ParsedComment
 * @typedef {import('../common/parse-detail.js').AdvisoryRef} AdvisoryRef
 * @typedef {import('../common/merge.js').MergedState} MergedState
 * @typedef {import('../common/write.js').WriteResult} WriteResult
 * @typedef {import('../common/write.js').WriteFetch} WriteFetch
 */

/**
 * @typedef {object} StateWriteResult
 * @property {boolean} ok
 * @property {string | null} reason One of `allowlist`, `in-flight`, `fetch`,
 *   `mismatch`, `unreadable`, `stale`, `superseded`, `read-only`,
 *   `confirmation`, `ambiguous`, `invalid`, the reason a caller's `guard`
 *   named, the reasons a write of the comment itself carries, and null on
 *   success.
 * @property {number | null} status
 * @property {string} message What happened, in the words the panel shows.
 * @property {Record<string, unknown> | null} snapshot The snapshot this write
 *   put on the advisory, and null where nothing was written.
 * @property {MergedState | null} merged The state the fetched page carried,
 *   and null where the write never read one. A refused write hands this back
 *   so the panel reloads from what the advisory says now.
 * @property {ParsedDetail | null} advisory The advisory as it stands once this
 *   write landed: the page this write read, carrying the comment it wrote.
 *   Null where nothing was written.
 * @property {number | null} readAt When that page was read, epoch
 *   milliseconds. Everything in the advisory but this write's own comment was
 *   observed then, so it is the observation time a cache entry holding it
 *   carries.
 */

/**
 * @typedef {(envelope: { by: string, at: string }) => Record<string, unknown>} ChangesBuilder
 */

/**
 * Which snapshot holds current state, as far as anything outside the merge can
 * tell: the comment it sits in, and the account it belongs to. A state the
 * panel remembers from a write of its own names no comment in this document,
 * and the login it was written under stands for it.
 *
 * @typedef {object} SnapshotHolder
 * @property {string | null} commentId
 * @property {string | null} by
 */

/**
 * @typedef {object} StateWriteOptions
 * @property {AdvisoryRef} ref The advisory to write on, read from the page.
 * @property {number} loadedSeq The highest ordering claim the panel loaded
 *   with. A page that has moved past it refuses the write.
 * @property {SnapshotHolder} [loadedHolder] Which snapshot held state when the
 *   panel loaded. A sequence number is not on its own an identity: two
 *   maintainers writing at once claim the same one, and the tie sends state to
 *   one of them. A holder that is not the one the panel loaded with refuses
 *   the write, whatever the sequence says.
 * @property {Record<string, unknown> | ChangesBuilder} changes The panel's
 *   changes, as snapshot fields. A field named null is removed, and a field
 *   not named is carried forward whether or not this reader knows it. A
 *   builder is handed the login and the time this write stamps, which is what
 *   a record naming who did something binds to.
 * @property {boolean} [confirmed] Whether the maintainer has confirmed a write
 *   that supersedes a snapshot this reader could not interpret.
 * @property {(state: Record<string, unknown> | null, changes: Record<string,
 *   unknown>) => { reason: string, message: string } | null} [guard] A last
 *   look at the changes against the state this write builds on, which is the
 *   state its own fetch read and not the one the panel was loaded with. An
 *   objection refuses the write, and is what the panel says.
 * @property {string} [at] The write time. The clock is read when this is
 *   absent.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {() => void} [beforeSend] Called once the comment request is built
 *   and before it goes out.
 */

(() => {
  /**
   * What the panel says while a write on this advisory is already going out.
   * The controls that started it are held still until it settles, so this is
   * the state of a disabled control and not a refusal a press can reach.
   */
  const IN_FLIGHT_MESSAGE = globalThis.bghsa.write.SAVING_MESSAGE;

  /**
   * The advisories a write is going out for. A second write while one is in
   * flight would compute its sequence number from a page the first one has not
   * landed on yet, and both would claim the same one.
   *
   * @type {Set<string>}
   */
  const inFlight = new Set();

  /**
   * @param {AdvisoryRef} ref
   * @returns {string} the key an advisory's write is held under.
   */
  function advisoryKey(ref) {
    // Lowercased, because the allowlist and the reference check read a reference
    // case-insensitively and two spellings of one advisory are one advisory.
    return `${ref.owner}/${ref.repo}/${ref.ghsaId}`.toLowerCase();
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
   * @param {string | null | undefined} left
   * @param {string | null | undefined} right
   * @returns {boolean} whether both name one GitHub account. Logins differ in
   *   case between places GitHub renders them and name one account.
   */
  function sameLogin(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    return left.toLowerCase() === right.toLowerCase();
  }

  /**
   * @param {MergedState} merged
   * @returns {SnapshotHolder} which snapshot this state came from.
   */
  function holderOf(merged) {
    const by = merged.state === null ? undefined : merged.state['by'];
    // A snapshot the extension wrote onto a comment it has not read back names
    // no identifier, and an empty one is that and not a comment of its own.
    const commentId = merged.source?.id ?? '';
    return {
      commentId: commentId === '' ? null : commentId,
      by: merged.source?.author ?? (typeof by === 'string' ? by : null),
    };
  }

  /**
   * Whether two readings name one snapshot. The comment id settles it where both
   * readings have one; a state remembered from a write of this panel's own names
   * no comment, and there the login it went out under is what there is to
   * compare.
   *
   * @param {SnapshotHolder} left
   * @param {SnapshotHolder} right
   * @returns {boolean}
   */
  function sameHolder(left, right) {
    if (left.commentId !== null && right.commentId !== null) {
      return left.commentId === right.commentId;
    }
    if (left.by === null || right.by === null) return left.by === right.by;
    return sameLogin(left.by, right.by);
  }

  /**
   * The JSON a state comment carries. Two spaces of indent put every line under
   * a key, so no line of it can read as the end of the fence that holds it.
   *
   * @param {Record<string, unknown>} snapshot
   * @returns {string}
   */
  function snapshotJson(snapshot) {
    return JSON.stringify(snapshot, null, 2);
  }

  /**
   * The body of a state comment: the collapsed block REQUIREMENTS.md section 3
   * describes, holding the marker and the snapshot.
   *
   * The marker is a code span outside the fence, which is what says the comment
   * is a state comment whatever the fence holds. Everything the snapshot says is
   * inside the fence, so no value in it renders as markup.
   *
   * The block's own tags each stand on a line with a blank line between them and
   * what they wrap, which is the shape the summary's link is known to render in.
   *
   * @param {Record<string, unknown>} snapshot
   * @returns {string}
   */
  function buildBody(snapshot) {
    const schema = globalThis.bghsa.schema;
    return [
      '<details>',
      '',
      `<summary>${schema.STATE_COMMENT_SUMMARY}</summary>`,
      '',
      `\`${schema.STATE_COMMENT_MARKER}\``,
      '',
      '```json',
      snapshotJson(snapshot),
      '```',
      '',
      '</details>',
      '',
    ].join('\n');
  }

  /**
   * The state comments one maintainer wrote on this advisory. The write model
   * puts at most one there, and no maintainer writes to anyone else's.
   *
   * @param {readonly ParsedComment[]} comments
   * @param {string} login
   * @returns {ParsedComment[]}
   */
  function ownStateComments(comments, login) {
    return comments.filter(
      (comment) => comment.stateComment !== null && sameLogin(comment.author, login)
    );
  }

  /**
   * @returns {string} the write time, to the second. `at` is informational
   *   because maintainer clocks differ, so nothing reads it finer than that.
   */
  function nowStamp() {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  /**
   * How long an advisory has been waiting is measured from `triageSince`, and
   * the triage value an advisory carries for the first time is where that
   * measurement starts. It starts at the most recent member action the page
   * carries, and at the report time where no member has acted, so an advisory a
   * maintainer has been working on does not read as having arrived at the moment
   * its triage value was set.
   *
   * @param {ParsedDetail} advisory The advisory as the write's own fetch read it.
   * @returns {string | null}
   */
  function seedTriageSince(advisory) {
    return globalThis.bghsa.derive.derive(advisory).lastMemberActivityAt ?? advisory.reportedAt;
  }

  /**
   * Stamps `triageSince` with the write time when this write changes the triage
   * value, and leaves it as the merged state carried it when it does not. A
   * write that names `triageSince` itself is left alone.
   *
   * A write that gives an advisory a triage value where the state it builds on
   * carries none stamps `seed`, whatever else has been written to that advisory.
   * REQUIREMENTS.md section 6 measures a first triage value from the most recent
   * maintainer action, and a maintainer who replied three weeks ago and saved an
   * owner yesterday has been waiting three weeks. The write time stands in where
   * the page offered nothing to seed from.
   *
   * A write that takes the triage value away takes the time with it. What
   * `triageSince` measures is how long the advisory has stood in its triage
   * value, and a snapshot with no triage value stands in none.
   *
   * @param {Record<string, unknown>} snapshot
   * @param {Record<string, unknown> | null} current
   * @param {Record<string, unknown>} changes
   * @param {string} at
   * @param {string | null} seed Where a first triage value measures from, and
   *   null where the page offered nothing to seed from.
   * @returns {void}
   */
  function stampTriageSince(snapshot, current, changes, at, seed) {
    if (Object.hasOwn(changes, 'triageSince')) return;
    const before = current === null ? undefined : current['triage'];
    if (snapshot['triage'] === before) return;
    if (snapshot['triage'] === undefined) {
      delete snapshot['triageSince'];
      return;
    }
    snapshot['triageSince'] = before === undefined ? (seed ?? at) : at;
  }

  /**
   * @param {string | null} reason
   * @param {number | null} status
   * @param {string} message
   * @param {MergedState | null} merged
   * @returns {StateWriteResult}
   */
  function refused(reason, status, message, merged) {
    return {
      ok: false,
      reason,
      status,
      message,
      snapshot: null,
      merged,
      advisory: null,
      readAt: null,
    };
  }

  /**
   * The badge GitHub renders beside this account on this advisory, which is
   * what says whether its snapshots count toward state. A comment it already
   * holds carries the badge; where it holds none, a member badge this account
   * carried on another advisory in the same organization stands for it, and
   * that is the whole of what the extension has seen.
   *
   * @param {ParsedDetail} fresh The advisory as this write read it.
   * @param {string} viewer The account this write went out under.
   * @returns {string | null}
   */
  function roleOf(fresh, viewer) {
    const trust = globalThis.bghsa.trust;
    /** @type {string[]} */
    const roles = [];
    for (const comment of fresh.comments) {
      if (!sameLogin(comment.author, viewer)) continue;
      for (const badge of comment.roles) if (!roles.includes(badge)) roles.push(badge);
    }
    const known = trust.ROLES.find((role) => roles.includes(role)) ?? roles[0] ?? null;
    if (known !== null) return known;
    return globalThis.bghsa.members.isKnown(fresh.ref, viewer) ? 'Member' : null;
  }

  /**
   * The comment this write left on the advisory, in the shape a reader of the
   * page parses one into.
   *
   * A created comment names no identifier: GitHub minted one and the page this
   * write read does not carry it. The account it went out under is what stands
   * for it until the advisory is read again, which is what {@link holderOf}
   * falls back on.
   *
   * @param {ParsedDetail} fresh The advisory as this write read it.
   * @param {string} viewer The account this write went out under.
   * @param {ParsedComment | undefined} mine The comment this write edited, and
   *   undefined where it created one.
   * @param {import('../common/schema.js').SnapshotReport} report The snapshot
   *   this write put in that comment, as this extension reads it back.
   * @param {string} at The write time.
   * @returns {ParsedComment}
   */
  function writtenComment(fresh, viewer, mine, report, at) {
    const schema = globalThis.bghsa.schema;
    // What the collapsed block renders to: the summary, the marker in its code
    // span, and the fence. It is the text a reader of the page would collapse
    // out of the comment body.
    const text = [schema.STATE_COMMENT_SUMMARY, schema.STATE_COMMENT_MARKER, report.raw]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (mine !== undefined) return { ...mine, text, stateComment: report };
    const role = roleOf(fresh, viewer);
    return {
      id: '',
      elementId: '',
      author: viewer,
      role,
      roles: role === null ? [] : [role],
      trusted: globalThis.bghsa.trust.isTrustedAuthor(viewer, role),
      at,
      text,
      stateComment: report,
    };
  }

  /**
   * The advisory as it stands once this write landed. REQUIREMENTS.md section
   * 2: a write this extension makes updates the cache entry to carry what was
   * written, and the page this write read is everything else that entry holds.
   *
   * @param {ParsedDetail} fresh
   * @param {ParsedComment} written The comment this write left.
   * @param {ParsedComment | undefined} mine The comment it replaced, and
   *   undefined where it created one.
   * @returns {ParsedDetail}
   */
  function withWrite(fresh, written, mine) {
    const comments =
      mine === undefined
        ? [...fresh.comments, written]
        : fresh.comments.map((comment) => (comment === mine ? written : comment));
    return { ...fresh, comments };
  }

  /**
   * @param {WriteResult} outcome
   * @param {Record<string, unknown>} snapshot
   * @param {MergedState} merged
   * @param {{ advisory: ParsedDetail, readAt: number }} read What this write's
   *   own fetch read, and when.
   * @returns {StateWriteResult}
   */
  function settled(outcome, snapshot, merged, read) {
    return {
      ok: outcome.ok,
      reason: outcome.reason,
      status: outcome.status,
      message: outcome.message,
      snapshot: outcome.ok ? snapshot : null,
      merged,
      advisory: outcome.ok ? read.advisory : null,
      readAt: outcome.ok ? read.readAt : null,
    };
  }

  /**
   * Writes this maintainer's state comment on one advisory.
   *
   * The whole write runs against a document fetched at the moment it was asked
   * for: the snapshots it merges, the form it clones, and the comment it edits
   * all come from that one document. A page that has moved past the sequence
   * number the panel loaded with refuses the write, and so does a page where
   * that sequence belongs to another snapshot than the one the panel loaded, so
   * a change is never applied to state the maintainer did not see.
   *
   * The comment this maintainer already wrote is edited, and one is created
   * where they have written none. Another maintainer's comment is never the
   * target: the edit form for it is in the page, and posting it would overwrite
   * what they wrote in front of the reporter.
   *
   * @param {StateWriteOptions} options
   * @returns {Promise<StateWriteResult>}
   */
  async function writeState(options) {
    const write = globalThis.bghsa.write;
    const { ref, loadedSeq } = options;
    const nameWithOwner = `${ref.owner}/${ref.repo}`;

    if (!globalThis.bghsa.allowlist.isAllowed(nameWithOwner)) {
      return refused('allowlist', null, write.allowlistMessage(nameWithOwner), null);
    }

    const key = advisoryKey(ref);
    if (inFlight.has(key)) return refused('in-flight', null, IN_FLIGHT_MESSAGE, null);
    // Held before anything is awaited, and released once this write settles.
    inFlight.add(key);
    try {
      const send = options.fetch;
      const toDocument = options.parseDocument;
      // Read before the request goes out, because it is when the page this
      // write reads was read, and an entry holding that page carries it.
      const readAt = globalThis.bghsa.cache.now();
      const fetched = await write.fetchAdvisoryPage(ref, {
        ...(send === undefined ? {} : { fetch: send }),
        ...(toDocument === undefined ? {} : { parseDocument: toDocument }),
      });
      if (fetched.failure !== null || fetched.page === null) {
        const failure = fetched.failure;
        if (failure === null) {
          return refused('fetch', null, write.REFRESH_MESSAGE, null);
        }
        return refused(failure.reason, failure.status, failure.message, null);
      }
      const page = fetched.page;

      const fresh = globalThis.bghsa.parseDetail.parseDetail(page);
      if (fresh === null || fresh.ref === null || !sameRef(fresh.ref, ref)) {
        return refused('mismatch', null, write.mismatchMessage(ref), null);
      }

      const viewer = fresh.viewer;
      if (viewer === null) {
        return refused(
          'unreadable',
          null,
          'Error: this extension could not read which account it is signed in' +
            ' as, and a write under the wrong account is not one it can take back.',
          null
        );
      }

      const merged = globalThis.bghsa.merge.mergeSnapshots(fresh.comments);
      if (merged.observedSeq !== loadedSeq) {
        return refused(
          'stale',
          null,
          'Error: concurrent edits',
          merged
        );
      }
      // Before the holder gate, because a maintainer holding two state comments
      // is told to delete one and can act on that. Reading the advisory again
      // would find the same two, and the write model in REQUIREMENTS.md section 3
      // puts one comment per maintainer on an advisory.
      const own = ownStateComments(fresh.comments, viewer);
      if (own.length > 1) {
        return refused(
          'ambiguous',
          null,
          `Error: ${viewer} has ${own.length} state comments on this advisory,` +
            ' and this extension writes one. Delete the ones that do not belong.',
          merged
        );
      }

      const expected = options.loadedHolder;
      if (expected !== undefined && !sameHolder(expected, holderOf(merged))) {
        const found = holderOf(merged).by;
        return refused(
          'superseded',
          null,
          `Error: this advisory's state at sequence ${merged.observedSeq} comes from` +
            ` ${found ?? 'another maintainer'} now, and not from the snapshot the panel was loaded` +
            ' with. Reload and apply the change again.',
          merged
        );
      }
      if (merged.readOnly) {
        return refused('read-only', null, 'Error: update the extension', merged);
      }
      if (merged.confirmationRequired && options.confirmed !== true) {
        return refused('confirmation', null, 'Error: unparsed tracking state', merged);
      }

      const at = options.at ?? nowStamp();
      // The changes are asked for once the login and the time are settled, so a
      // record inside them names the account this write goes out under.
      const changes =
        typeof options.changes === 'function' ? options.changes({ by: viewer, at }) : options.changes;
      const objection = options.guard?.(merged.state, changes) ?? null;
      if (objection !== null) {
        return refused(objection.reason, null, objection.message, merged);
      }

      const snapshot = globalThis.bghsa.merge.nextSnapshot(merged.state, changes, {
        by: viewer,
        at,
        seq: merged.nextSeq,
      });
      stampTriageSince(snapshot, merged.state, changes, at, seedTriageSince(fresh));

      // The snapshot goes through this extension's own reader before it goes
      // out. A payload the reader would exclude is one no reader takes as state,
      // and an advisory carrying a snapshot the extension that wrote it refuses
      // to read is one nobody can write from until it is superseded by hand.
      const json = snapshotJson(snapshot);
      const reading = globalThis.bghsa.schema.readSnapshot(json);
      if (!reading.valid) {
        return refused(
          'invalid',
          null,
          'Error: the snapshot this extension built is one it would not read' +
            ` back: ${reading.problems.join('; ')}.`,
          merged
        );
      }

      const body = buildBody(snapshot);
      const contains = [globalThis.bghsa.schema.STATE_COMMENT_MARKER, json];
      /** @type {{ doc: Document, ref: AdvisoryRef, body: string, contains: string[] }} */
      const common = { doc: page, ref: fresh.ref, body, contains };
      const passed = {
        ...(send === undefined ? {} : { fetch: send }),
        ...(toDocument === undefined ? {} : { parseDocument: toDocument }),
        ...(options.beforeSend === undefined ? {} : { beforeSend: options.beforeSend }),
      };
      const mine = own[0];
      const outcome =
        mine === undefined
          ? await write.createComment({ ...common, ...passed })
          : await write.editComment({ ...common, commentId: mine.id, ...passed });
      return settled(outcome, snapshot, merged, {
        advisory: withWrite(fresh, writtenComment(fresh, viewer, mine, reading, at), mine),
        readAt,
      });
    } finally {
      inFlight.delete(key);
    }
  }

  const exported = {
    IN_FLIGHT_MESSAGE,
    inFlight,
    advisoryKey,
    sameLogin,
    buildBody,
    holderOf,
    sameHolder,
    stampTriageSince,
    writeState,
  };

  globalThis.bghsa.state = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
