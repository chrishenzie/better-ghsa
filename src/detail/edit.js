'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/dom.js');
  require('../common/text.js');
  require('../common/schema.js');
  require('../common/merge.js');
  require('../common/parse-detail.js');
  require('../common/derive.js');
  require('../common/members.js');
  require('../common/branches.js');
  require('./tracking.js');
  require('./state.js');
}

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/derive.js').DerivedState} DerivedState
 * @typedef {import('../common/merge.js').MergedState} MergedState
 * @typedef {import('../common/write.js').WriteFetch} WriteFetch
 * @typedef {import('./tracking.js').TrackingView} TrackingView
 * @typedef {import('./tracking.js').Fingerprints} Fingerprints
 * @typedef {import('./tracking.js').ConfirmationTrack} ConfirmationTrack
 * @typedef {import('./state.js').StateWriteResult} StateWriteResult
 */

/**
 * The values the controls hold that the advisory does not. A field is present
 * only while it differs from the stored state, so an advisory with an entry
 * here is one with changes waiting to be written.
 *
 * @typedef {object} Pending
 * @property {string | null} [triage]
 * @property {string[]} [owners]
 * @property {string[]} [backports]
 * @property {boolean} [embargo]
 * @property {string | null} [embargoLift]
 * @property {string | null} [closureReason]
 * @property {string | null} [closureDuplicateOf]
 * @property {Partial<Record<ConfirmationTrack, boolean>>} [confirm]
 * @property {boolean} [supersede] Whether the maintainer has confirmed a write
 *   that supersedes a snapshot this reader could not interpret. It is not a
 *   change of its own, and it is not carried into a snapshot.
 */

/**
 * Everything the editing controls read, and everything a save needs. The panel
 * builds one of these per pass, so the controls always describe the document
 * the panel last read.
 *
 * @typedef {object} EditorContext
 * @property {ParsedDetail} advisory
 * @property {DerivedState} derived
 * @property {TrackingView} tracking The stored state, as the panel displays it.
 * @property {Fingerprints} fingerprints The fingerprints of the values the
 *   confirmations bind to, which are what a confirmation written here records.
 * @property {MergedState} merged The state the panel loaded with. Its
 *   `observedSeq` is what a write is refused against.
 * @property {() => Promise<void> | void} [rerender] Runs a render pass, which
 *   is how the panel shows what a write left behind.
 * @property {WriteFetch} [fetch]
 * @property {(html: string) => Document} [parseDocument]
 * @property {string} [at] The write time, for a test that stamps its own.
 */

/**
 * What a save would carry, and what it could not.
 *
 * A confirmation binds to a fingerprint of the value on the page, so a staged
 * confirmation of a value the page did not give has nothing to record. It is
 * not a change the panel can write, and it is not a change the panel forgets:
 * it stays staged and is named, because a maintainer who ticked it is owed the
 * reason it did not go.
 *
 * @typedef {object} Writable
 * @property {Pending} diff The staged values a save writes.
 * @property {ConfirmationTrack[]} blocked The confirmations it cannot record.
 */

/**
 * One list of values a maintainer adds to and removes from: a chip per value
 * carrying a Remove button, a text field with the candidates behind it, and an
 * Add button. Owners and backport targets are one control over two sets of
 * values.
 *
 * @typedef {object} ChipList
 * @property {string} label The row's label.
 * @property {string} name The stem of the `bghsa-` class every part carries.
 * @property {string} noun What one value is, as the Remove button names it.
 * @property {string} placeholder
 * @property {string[]} candidates The values offered behind the text field, in
 *   the order they are offered.
 * @property {(value: string) => string} fold Two values folding alike are one
 *   value. A login names one account whatever its case; a git branch name is
 *   case-sensitive and names one branch only as it is spelled.
 * @property {string | null} unknown What a value outside the candidates is
 *   marked with, and null where a value outside them is unremarkable.
 * @property {Map<string, string>} drafts Where the half-typed value lives
 *   between passes.
 * @property {() => string[]} held What the control holds now.
 * @property {(values: string[]) => void} put Records what it holds.
 */

(() => {
  /** What the panel says where a snapshot names a schema version it cannot read. */
  const READ_ONLY_MESSAGE =
    'This advisory carries tracking state in a schema version this extension does not' +
    ' read, so the panel cannot edit it. Update the extension.';

  /** What the panel says once a write has landed. */
  const SAVED_MESSAGE = 'Saved. The advisory carries these values now.';

  /**
   * What the panel says once a write has landed and the controls still hold
   * something that write did not carry.
   */
  const SAVED_PENDING_MESSAGE =
    'Saved. The panel still holds changes that write did not carry, and they are unsaved.';

  /** What the panel says while a write from it is on its way to GitHub. */
  const WRITING_MESSAGE = 'Writing to GitHub.';

  /** What marks a control the flight took away, so the flight can give it back. */
  const FLIGHT_MARK = 'data-bghsa-flight';

  /** What the panel says when Save is pressed with every control as it stands. */
  const UNCHANGED_MESSAGE = 'Nothing was written: no control on this panel holds a change.';

  /** What the panel says where the page did not say which advisory it is. */
  const UNREADABLE_MESSAGE =
    'Nothing was written: this extension could not read which advisory this page is.';

  /** What a maintainer is asked before leaving changes that were never written. */
  const LEAVE_MESSAGE =
    'This panel holds tracking changes that were never saved. Leave them behind?';

  /** What the checkbox reads that supersedes a snapshot the merge would not take. */
  const SUPERSEDE_LABEL =
    'Supersede the snapshot this extension could not read';

  /**
   * The advisories with control changes waiting, keyed as {@link keyOf} keys
   * them. The store outlives a render pass, which is what carries an unsaved
   * change across GitHub replacing the panel's surroundings.
   *
   * @type {Map<string, Pending>}
   */
  const edits = new Map();

  /**
   * The state a write left an advisory in, which the page's own markup does not
   * show: a comment written from here is on GitHub, not in this document. The
   * panel reads this in preference to the document while it is ahead.
   *
   * @type {Map<string, MergedState>}
   */
  const written = new Map();

  /**
   * What the last save on an advisory did, in the words the panel shows.
   *
   * @type {Map<string, { ok: boolean, message: string }>}
   */
  const results = new Map();

  /** The advisories whose editing disclosure the maintainer has opened. */
  const opened = new Set();

  /**
   * The half-typed owner logins, keyed as {@link keyOf} keys them. A login is a
   * change once it is added and not before, and until then it is text in a
   * control that a render pass would otherwise take away.
   *
   * @type {Map<string, string>}
   */
  const drafts = new Map();

  /**
   * The half-typed backport branches, held as {@link drafts} holds a login.
   *
   * @type {Map<string, string>}
   */
  const branchDrafts = new Map();

  /**
   * The advisory the panel is showing, keyed as {@link keyOf} keys them, and
   * null where the page shows none. The staged values outlive the page, so this
   * is what says which of them belong to the advisory in front of the
   * maintainer and which belong to one already left.
   *
   * @type {{ key: string | null }}
   */
  const showing = { key: null };

  /**
   * How the panel puts a yes-or-no question to the maintainer, and null while
   * no warning is armed. A pass finds the page has left an advisory long after
   * the arming, so the arming leaves what it settled on here.
   *
   * @type {((message: string) => boolean) | null}
   */
  let asker = null;

  /**
   * The advisories a save from this panel is on its way to GitHub for. A pass
   * during the flight builds the controls again, and this is what the pass reads
   * to build them held still: a value staged against a request already out is a
   * value that request does not carry.
   *
   * @type {Set<string>}
   */
  const saving = new Set();

  /**
   * @param {ParsedDetail} advisory
   * @returns {string} the key this advisory's changes are held under. Two
   *   spellings of one advisory are one advisory, as they are for a write.
   */
  function keyOf(advisory) {
    const ref = advisory.ref;
    const name = ref === null ? (advisory.ghsaId ?? '') : `${ref.owner}/${ref.repo}/${ref.ghsaId}`;
    return name.toLowerCase();
  }

  /**
   * @param {string} key
   * @returns {Pending} the changes waiting on this advisory.
   */
  function editsFor(key) {
    return edits.get(key) ?? {};
  }

  /**
   * @param {string} key
   * @param {Pending} patch
   * @returns {void} records what a control now holds.
   */
  function stage(key, patch) {
    edits.set(key, { ...editsFor(key), ...patch });
    results.delete(key);
  }

  /**
   * @param {string} key
   * @param {ConfirmationTrack} track
   * @param {boolean} value
   * @returns {void}
   */
  function stageConfirmation(key, track, value) {
    stage(key, { confirm: { ...editsFor(key).confirm, [track]: value } });
  }

  /**
   * @param {string} key
   * @returns {void} drops every change waiting on this advisory.
   */
  function discard(key) {
    edits.delete(key);
    results.delete(key);
    drafts.delete(key);
    branchDrafts.delete(key);
  }

  /**
   * What makes two logins one account. GitHub reads a login case-insensitively,
   * so `SamuelKarp` and `samuelkarp` are one owner, and the same fold decides
   * whether the Add button takes a typed login the list already holds.
   *
   * @param {string} login
   * @returns {string}
   */
  function foldLogin(login) {
    return login.toLowerCase();
  }

  /**
   * What makes two GHSA identifiers one advisory. GitHub reads the identifier
   * case-insensitively, so `GHSA-cm76-qm8v-3j95` and `ghsa-cm76-qm8v-3j95` name
   * one advisory, as they do to {@link keyOf}.
   *
   * @param {string | null | undefined} id
   * @returns {string | null | undefined}
   */
  function foldGhsaId(id) {
    return typeof id === 'string' ? id.toLowerCase() : id;
  }

  /**
   * Owners and backport targets are sets: REQUIREMENTS.md section 6 has owners be
   * org members and backports be release branches, and neither carries an order
   * that means anything. A value taken off and put back leaves the same set in a
   * different order, and that is not a change.
   *
   * Sameness is the value's own: `fold` is what makes two spellings one value,
   * and a login folds where a git branch name, which names one branch only as it
   * is spelled, does not.
   *
   * @param {string[]} left
   * @param {string[]} right
   * @param {(value: string) => string} [fold]
   * @returns {boolean} whether both name the same values.
   */
  function sameList(left, right, fold = (value) => value) {
    if (left.length !== right.length) return false;
    const one = left.map(fold).sort();
    const two = right.map(fold).sort();
    return one.every((value, index) => value === two[index]);
  }

  /**
   * @template T
   * @param {T | undefined} staged
   * @param {T} stored
   * @returns {T} what a control holds: what was typed into it where anything was,
   *   and the stored value otherwise. A staged null is a value cleared by hand
   *   and is not the absence of one.
   */
  function pick(staged, stored) {
    return staged === undefined ? stored : staged;
  }

  /**
   * The fields of `pending` the advisory does not already carry. A control put
   * back where it started is not a change. A value in a control whose gate is
   * off is one the panel holds and a save does not write, and it is here,
   * because the panel is what holds it.
   *
   * @param {TrackingView} tracking
   * @param {Pending} pending
   * @returns {Pending}
   */
  function staged(tracking, pending) {
    /** @type {Pending} */
    const kept = {};
    if (pending.triage !== undefined && pending.triage !== tracking.triage) {
      kept.triage = pending.triage;
    }
    if (pending.owners !== undefined && !sameList(pending.owners, tracking.owners, foldLogin)) {
      kept.owners = pending.owners;
    }
    if (pending.backports !== undefined && !sameList(pending.backports, tracking.backports)) {
      kept.backports = pending.backports;
    }
    if (pending.embargo !== undefined && pending.embargo !== tracking.embargo) {
      kept.embargo = pending.embargo;
    }
    if (pending.embargoLift !== undefined && pending.embargoLift !== tracking.embargoLift) {
      kept.embargoLift = pending.embargoLift;
    }
    if (pending.closureReason !== undefined && pending.closureReason !== tracking.closureReason) {
      kept.closureReason = pending.closureReason;
    }
    if (
      pending.closureDuplicateOf !== undefined &&
      foldGhsaId(pending.closureDuplicateOf) !== foldGhsaId(tracking.closureDuplicateOf)
    ) {
      kept.closureDuplicateOf = pending.closureDuplicateOf;
    }
    /** @type {Partial<Record<ConfirmationTrack, boolean>>} */
    const confirm = {};
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      const value = pending.confirm?.[track.key];
      if (value === undefined) continue;
      if (value === (tracking[track.key].status === 'confirmed')) continue;
      confirm[track.key] = value;
    }
    if (Object.keys(confirm).length > 0) kept.confirm = confirm;
    if (pending.supersede !== undefined) kept.supersede = pending.supersede;
    return kept;
  }

  /**
   * The staged fields a save writes: the ones the advisory does not already
   * carry, less a date on an embargo that is off and a duplicate on a closure
   * that is not a duplicate. Neither has a place in the snapshot the controls
   * describe, so neither is a change to write.
   *
   * @param {TrackingView} tracking
   * @param {Pending} pending
   * @returns {Pending}
   */
  function differences(tracking, pending) {
    const kept = staged(tracking, pending);
    if (!pick(pending.embargo, tracking.embargo)) delete kept.embargoLift;
    if (pick(pending.closureReason, tracking.closureReason) !== 'duplicate') {
      delete kept.closureDuplicateOf;
    }
    return kept;
  }

  /**
   * The values a control holds that a save leaves behind, and what the panel says
   * about each. A maintainer who typed a date and then turned the embargo off
   * still has the date, and is told it is not going anywhere until the embargo is
   * back on.
   *
   * @type {Record<string, string>}
   */
  const HELD_NOTES = {
    embargoLift: 'The lift date is held and is not written while the embargo is off.',
    closureDuplicateOf:
      'The duplicate advisory is held and is not written while the closure reason is not' +
      ' duplicate.',
  };

  /**
   * @param {TrackingView} tracking
   * @param {Pending} pending
   * @returns {string[]} the staged fields a save leaves behind because the
   *   control that gates them is off.
   */
  function heldTracks(tracking, pending) {
    const all = staged(tracking, pending);
    const writing = differences(tracking, pending);
    /** @type {string[]} */
    const names = [];
    if (all.embargoLift !== undefined && writing.embargoLift === undefined) {
      names.push('embargoLift');
    }
    if (all.closureDuplicateOf !== undefined && writing.closureDuplicateOf === undefined) {
      names.push('closureDuplicateOf');
    }
    return names;
  }

  /**
   * The one gate a save, the Save button, and the note all read. What
   * {@link changesOf} writes is what this says is writable, so the panel never
   * counts a change the write would leave out.
   *
   * @param {TrackingView} tracking
   * @param {Fingerprints} fingerprints
   * @param {Pending} pending
   * @returns {Writable}
   */
  function writable(tracking, fingerprints, pending) {
    const diff = differences(tracking, pending);
    /** @type {ConfirmationTrack[]} */
    const blocked = [];
    if (diff.confirm !== undefined) {
      /** @type {Partial<Record<ConfirmationTrack, boolean>>} */
      const recordable = {};
      for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
        const staged = diff.confirm[track.key];
        if (staged === undefined) continue;
        if (staged && fingerprints[track.key] === null) blocked.push(track.key);
        else recordable[track.key] = staged;
      }
      if (Object.keys(recordable).length === 0) delete diff.confirm;
      else diff.confirm = recordable;
    }
    return { diff, blocked };
  }

  /**
   * @param {TrackingView} tracking
   * @param {Fingerprints} fingerprints
   * @param {Pending} pending
   * @returns {string[]} the confirmations a save cannot record, named as the
   *   panel names them.
   */
  function blockedTracks(tracking, fingerprints, pending) {
    const blocked = writable(tracking, fingerprints, pending).blocked;
    return globalThis.bghsa.tracking.CONFIRMATION_TRACKS.filter((track) =>
      blocked.includes(track.key)
    ).map((track) => track.short);
  }

  /**
   * @param {string[]} names
   * @returns {string} what the panel says beside a confirmation it cannot record.
   */
  function unrecordedNote(names) {
    return (
      `A confirmation of the ${names.join(', ')} cannot be recorded:` +
      ' the value on the page could not be read.'
    );
  }

  /**
   * @param {string[]} names
   * @returns {string} what the panel says where that is all a save would carry.
   */
  function unrecordedMessage(names) {
    return (
      'Nothing was written: the value on the page could not be read, so a confirmation of the' +
      ` ${names.join(', ')} cannot be recorded.`
    );
  }

  /**
   * The tracks whose controls hold something the advisory does not, named as the
   * panel names them. An empty list is a panel with nothing to write.
   *
   * @param {TrackingView} tracking
   * @param {Fingerprints} fingerprints
   * @param {Pending} pending
   * @returns {string[]}
   */
  function changedTracks(tracking, fingerprints, pending) {
    const diff = writable(tracking, fingerprints, pending).diff;
    /** @type {string[]} */
    const names = [];
    if (diff.triage !== undefined) names.push('triage');
    if (diff.owners !== undefined) names.push('owners');
    if (diff.backports !== undefined) names.push('backport targets');
    if (diff.embargo !== undefined || diff.embargoLift !== undefined) names.push('embargo');
    if (diff.closureReason !== undefined || diff.closureDuplicateOf !== undefined) {
      names.push('closure reason');
    }
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      if (diff.confirm?.[track.key] !== undefined) names.push(track.short);
    }
    return names;
  }

  /**
   * Drops the staged values the advisory has caught up with, so a control put
   * back where it started, and a value another maintainer wrote in the meantime,
   * both stop counting as unsaved work.
   *
   * A confirmation the panel cannot record is not one the advisory has caught up
   * with, so it stays where it is and the panel keeps saying so. Neither is a
   * value whose gate is off: a save leaves it behind, and a pass that dropped it
   * would take typing the maintainer can still see.
   *
   * @param {string} key
   * @param {TrackingView} tracking
   * @returns {void}
   */
  function prune(key, tracking) {
    const pending = edits.get(key);
    if (pending === undefined) return;
    const kept = staged(tracking, pending);
    if (PENDING_FIELDS.every((field) => !Object.hasOwn(kept, field)) && kept.supersede !== true) {
      edits.delete(key);
    } else {
      edits.set(key, kept);
    }
  }

  /**
   * Takes the staged values a write carried back out and leaves the rest where
   * it is. A value staged after the request went is not in that request, so
   * dropping it would lose work the panel never wrote and never reported.
   *
   * The confirmation that supersedes an unreadable snapshot is spent on the
   * write that carried it.
   *
   * @param {string} key
   * @param {Pending} captured The staged values the write carried.
   * @returns {void}
   */
  function release(key, captured) {
    const pending = edits.get(key);
    if (pending === undefined) return;
    /** @type {Pending} */
    const kept = { ...pending };
    if (captured.triage !== undefined && kept.triage === captured.triage) delete kept.triage;
    if (
      captured.owners !== undefined &&
      kept.owners !== undefined &&
      sameList(kept.owners, captured.owners, foldLogin)
    ) {
      delete kept.owners;
    }
    if (
      captured.backports !== undefined &&
      kept.backports !== undefined &&
      sameList(kept.backports, captured.backports)
    ) {
      delete kept.backports;
    }
    if (captured.embargo !== undefined && kept.embargo === captured.embargo) delete kept.embargo;
    if (captured.embargoLift !== undefined && kept.embargoLift === captured.embargoLift) {
      delete kept.embargoLift;
    }
    if (captured.closureReason !== undefined && kept.closureReason === captured.closureReason) {
      delete kept.closureReason;
    }
    if (
      captured.closureDuplicateOf !== undefined &&
      kept.closureDuplicateOf !== undefined &&
      foldGhsaId(kept.closureDuplicateOf) === foldGhsaId(captured.closureDuplicateOf)
    ) {
      delete kept.closureDuplicateOf;
    }
    if (captured.confirm !== undefined) {
      /** @type {Partial<Record<ConfirmationTrack, boolean>>} */
      const confirm = { ...kept.confirm };
      for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
        const written = captured.confirm[track.key];
        if (written !== undefined && confirm[track.key] === written) delete confirm[track.key];
      }
      if (Object.keys(confirm).length === 0) delete kept.confirm;
      else kept.confirm = confirm;
    }
    delete kept.supersede;
    if (Object.keys(kept).length === 0) edits.delete(key);
    else edits.set(key, kept);
  }

  /**
   * One field of a snapshot object, as a change carries it. A value the panel
   * holds is written; a value it does not hold takes the stored one away where
   * there is one and is left out where there is none, because null in a field
   * the snapshot never had is a null the validator refuses.
   *
   * @param {string} key
   * @param {string | null} value
   * @param {string | null} stored
   * @returns {Record<string, unknown>}
   */
  function optional(key, value, stored) {
    if (value !== null) return { [key]: value };
    return stored === null ? {} : { [key]: null };
  }

  /**
   * The staged fields that stand for work a maintainer would lose. The
   * confirmation that supersedes an unreadable snapshot is not among them: it
   * says how to write a change and is not one.
   *
   * @type {readonly string[]}
   */
  const PENDING_FIELDS = [
    'triage',
    'owners',
    'backports',
    'embargo',
    'embargoLift',
    'closureReason',
    'closureDuplicateOf',
    'confirm',
  ];

  /**
   * @param {string} key
   * @returns {boolean} whether this advisory holds a change that was never
   *   written.
   */
  function pendingOn(key) {
    const pending = edits.get(key);
    if (pending === undefined) return false;
    return PENDING_FIELDS.some((field) => Object.hasOwn(pending, field));
  }

  /**
   * @returns {boolean} whether any advisory this page has shown holds a change
   *   that was never written.
   */
  function anyPending() {
    for (const key of edits.keys()) {
      if (pendingOn(key)) return true;
    }
    return false;
  }

  /**
   * Records which advisory the panel is showing, and asks about the changes the
   * advisory the page has left still holds.
   *
   * A pass is what finds the page has moved: GitHub replaces the content frame
   * with no document load, so the departure reaches the extension as a render
   * pass over a document that shows another advisory or none. Answering yes
   * drops the changes, which is what leaving them behind is; answering no keeps
   * them staged, and the panel holds them again on the advisory they belong to.
   *
   * @param {string | null} key the advisory the panel is showing now.
   * @returns {void}
   */
  function panelShows(key) {
    const left = showing.key;
    if (left === key) return;
    showing.key = key;
    if (left === null || asker === null || !pendingOn(left)) return;
    if (asker(LEAVE_MESSAGE)) discard(left);
  }

  /**
   * Whether a click would take the maintainer off this page. A click that opens
   * a second place to read the advisory in, and a click that moves within the
   * page, both leave the panel where it is.
   *
   * @param {Event} event
   * @returns {boolean}
   */
  function leavesPage(event) {
    const mouse = /** @type {{ button?: unknown, metaKey?: unknown, ctrlKey?: unknown,
     *   shiftKey?: unknown, altKey?: unknown }} */ (/** @type {unknown} */ (event));
    if (typeof mouse.button === 'number' && mouse.button !== 0) return false;
    if (mouse.metaKey === true || mouse.ctrlKey === true) return false;
    if (mouse.shiftKey === true || mouse.altKey === true) return false;

    const start = /** @type {Node | null} */ (event.target);
    const from =
      start === null
        ? null
        : start.nodeType === 1
          ? /** @type {Element} */ (/** @type {unknown} */ (start))
          : start.parentElement;
    const anchor = from === null ? null : from.closest('a[href]');
    if (anchor === null || anchor.hasAttribute('download')) return false;
    const target = anchor.getAttribute('target');
    if (target !== null && target !== '' && target !== '_self') return false;
    const href = anchor.getAttribute('href') ?? '';
    return href !== '' && !href.startsWith('#');
  }

  /**
   * Warns before changes that were never written are lost.
   *
   * Three paths, because a page is left three ways. A document load fires
   * `beforeunload`, and the browser asks its own question there; the whole store
   * goes with the document, so every advisory holding a change is a reason to
   * ask. A link GitHub follows by replacing `#repo-content-turbo-frame` fires
   * nothing, so the click that starts it is asked about here and is stopped
   * where the answer is no: the handler runs before the page's own, and a click
   * it cancels never reaches the code that would swap the frame. A departure no
   * click started, the back button among them, reaches {@link panelShows} on the
   * pass that finds the page has moved.
   *
   * The click and the pass ask about the advisory the panel is showing. The
   * store outlives the page, so asking about any advisory would put the question
   * on the page after the one holding the changes.
   *
   * @param {Document} doc
   * @param {{ confirm?: (message: string) => boolean }} [options]
   * @returns {() => void} takes the warnings back off.
   */
  function armNavigationWarning(doc, options) {
    const view = doc.defaultView;
    const ask =
      options?.confirm ?? ((message) => view?.confirm === undefined || view.confirm(message));
    asker = ask;

    /** @param {Event} event @returns {void} */
    const onUnload = (event) => {
      if (!anyPending()) return;
      event.preventDefault();
      // What a browser asking the question of its own reads as a reason to.
      /** @type {{ returnValue?: unknown }} */ (/** @type {unknown} */ (event)).returnValue = '';
    };
    /** @param {Event} event @returns {void} */
    const onClick = (event) => {
      const key = showing.key;
      if (key === null || !pendingOn(key) || !leavesPage(event)) return;
      if (ask(LEAVE_MESSAGE)) {
        discard(key);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    view?.addEventListener('beforeunload', onUnload);
    doc.addEventListener('click', onClick, true);
    return () => {
      if (asker === ask) asker = null;
      view?.removeEventListener('beforeunload', onUnload);
      doc.removeEventListener('click', onClick, true);
    };
  }

  /**
   * The snapshot fields a save writes. Every value comes from the controls; a
   * track no control changed is not named, so the merge carries it forward.
   *
   * A confirmation records the login and the time the write itself stamps and the
   * fingerprint of the value on the page, which is the same fingerprint the
   * display is judged against, so a value confirmed here reads as confirmed on
   * the next pass.
   *
   * @param {TrackingView} tracking
   * @param {Fingerprints} fingerprints
   * @param {Pending} pending
   * @param {{ by: string, at: string }} envelope
   * @returns {Record<string, unknown>}
   */
  function changesOf(tracking, fingerprints, pending, envelope) {
    const diff = writable(tracking, fingerprints, pending).diff;
    /** @type {Record<string, unknown>} */
    const changes = {};

    if (diff.triage !== undefined) changes['triage'] = diff.triage;
    if (diff.owners !== undefined) changes['owners'] = diff.owners.length === 0 ? null : diff.owners;
    if (diff.backports !== undefined) {
      changes['backports'] = diff.backports.length === 0 ? null : diff.backports;
    }

    if (diff.embargo !== undefined || diff.embargoLift !== undefined) {
      const embargo = pick(pending.embargo, tracking.embargo);
      changes['embargo'] = embargo
        ? { ...optional('lift', pick(pending.embargoLift, tracking.embargoLift), tracking.embargoLift) }
        : null;
    }

    if (diff.closureReason !== undefined || diff.closureDuplicateOf !== undefined) {
      const reason = pick(pending.closureReason, tracking.closureReason);
      const duplicateOf = pick(pending.closureDuplicateOf, tracking.closureDuplicateOf);
      changes['closure'] =
        reason === null
          ? null
          : {
              reason,
              ...optional(
                'duplicateOf',
                reason === 'duplicate' ? duplicateOf : null,
                tracking.closureDuplicateOf
              ),
            };
    }

    /** @type {Record<string, unknown>} */
    const confirmed = {};
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      const staged = diff.confirm?.[track.key];
      if (staged === undefined) continue;
      if (!staged) {
        confirmed[track.key] = null;
        continue;
      }
      // The gate keeps a confirmation with nothing behind it out of the diff, so
      // a fingerprint stands behind every one that reaches here.
      const fingerprint = fingerprints[track.key];
      if (fingerprint === null) continue;
      confirmed[track.key] = { by: envelope.by, at: envelope.at, fp: fingerprint };
    }
    if (Object.keys(confirmed).length > 0) changes['confirmed'] = confirmed;

    return changes;
  }

  /**
   * The stored objects one control removes as a whole, and the fields this reader
   * knows inside each.
   *
   * @type {readonly { key: string, name: string, fields: readonly string[] }[]}
   */
  const NESTED_TRACKS = [
    { key: 'embargo', name: 'embargo', fields: ['lift'] },
    { key: 'closure', name: 'closure reason', fields: ['reason', 'duplicateOf'] },
  ];

  /**
   * The fields a stored object carries that this reader does not interpret.
   *
   * @param {Record<string, unknown> | null} state
   * @param {string} key
   * @param {readonly string[]} known
   * @returns {string[]}
   */
  function unknownFields(state, key, known) {
    const held = state === null ? undefined : state[key];
    if (!globalThis.bghsa.schema.isPlainObject(held)) return [];
    return Object.keys(held).filter((field) => !known.includes(field));
  }

  /**
   * The stored objects a save would take away that carry fields this reader does
   * not know.
   *
   * A control here stands for the record as a whole: the embargo is in force
   * while the object is there, so turning it off removes the object, and every
   * field inside it goes with it. REQUIREMENTS.md section 3 has a write preserve
   * what it does not recognize, and a field a newer version of this extension
   * wrote inside the embargo is exactly that. The write is refused and says
   * which fields stand in the way, because a refusal is recoverable by a
   * maintainer running a version that knows those fields and a deletion is not.
   *
   * @param {Record<string, unknown> | null} state The state the write builds on.
   * @param {Record<string, unknown>} changes
   * @returns {{ key: string, name: string, fields: string[] }[]}
   */
  function unclearable(state, changes) {
    /** @type {{ key: string, name: string, fields: string[] }[]} */
    const blocked = [];
    for (const track of NESTED_TRACKS) {
      if (changes[track.key] !== null) continue;
      const unknown = unknownFields(state, track.key, track.fields);
      if (unknown.length > 0) blocked.push({ key: track.key, name: track.name, fields: unknown });
    }
    return blocked;
  }

  /**
   * @param {{ key: string, name: string, fields: string[] }[]} blocked
   * @returns {string} what the panel says where a save would delete a field it
   *   does not know.
   */
  function unclearableMessage(blocked) {
    const names = blocked.map((one) => one.name).join(' and ');
    const fields = blocked
      .flatMap((one) => one.fields.map((field) => `${one.key}.${field}`))
      .join(', ');
    return (
      `Nothing was written: clearing the ${names} would delete ${fields}, which this extension` +
      ' does not recognize and carries forward untouched. Update the extension.'
    );
  }

  /**
   * @param {string} key
   * @param {MergedState} merged
   * @returns {void} holds the state an advisory stands in after a write this
   *   page made.
   */
  function remember(key, merged) {
    written.set(key, merged);
  }

  /**
   * The state the panel reads: the one a write from this page left behind while
   * it is ahead of the document, and the document's own once the page catches up.
   *
   * @param {string} key
   * @param {MergedState} fromPage The state this document's comments merge to.
   * @returns {MergedState}
   */
  function preferred(key, fromPage) {
    const held = written.get(key);
    if (held === undefined) return fromPage;
    if (fromPage.observedSeq >= held.observedSeq) {
      written.delete(key);
      return fromPage;
    }
    return held;
  }

  /**
   * The state an advisory stands in once a write of `outcome` landed: the
   * snapshot this page wrote, at the ordering claim it carried.
   *
   * @param {StateWriteResult} outcome
   * @returns {MergedState | null}
   */
  function afterWrite(outcome) {
    const merged = outcome.merged;
    if (merged === null || outcome.snapshot === null) return null;
    return {
      ...merged,
      state: outcome.snapshot,
      source: null,
      seq: merged.nextSeq,
      observedSeq: merged.nextSeq,
      nextSeq: merged.nextSeq + 1,
      // The write outranks the snapshot the merge would not take, so the next
      // one takes no confirmation of its own.
      confirmationRequired: false,
    };
  }

  /**
   * @param {string} reason
   * @param {string} message
   * @returns {StateWriteResult}
   */
  function refused(reason, message) {
    return { ok: false, reason, status: null, message, snapshot: null, merged: null };
  }

  /**
   * @param {unknown} error
   * @returns {string} what the panel says where a save ended in an error rather
   *   than a result. Where the request went and what became of it are both
   *   unknown here, and the message says so.
   */
  function failedMessage(error) {
    const detail = error instanceof Error ? error.message : String(error);
    return (
      `The save did not finish: ${detail}. This extension cannot tell whether the write` +
      ' landed. Reload the advisory to see what it carries.'
    );
  }

  /**
   * Asks for a render pass. A pass that fails is not one asking again would fix,
   * and the result a maintainer is owed is recorded before this runs, so the
   * failure ends here and the press that started the save puts the panel back.
   *
   * @param {EditorContext} context
   * @returns {Promise<void>}
   */
  async function repaint(context) {
    try {
      await context.rerender?.();
    } catch {
      // Nothing here can rebuild the panel. The controls come back where they
      // stand, and the note says what the last save did.
    }
  }

  /**
   * A save that stopped before a request was built. The reason is recorded and a
   * pass is asked for, because the press that started the save put "Writing to
   * GitHub" on the panel and disabled the controls, and the panel holds those
   * until something replaces them.
   *
   * @param {EditorContext} context
   * @param {string} key
   * @param {string} reason
   * @param {string} message
   * @returns {Promise<StateWriteResult>}
   */
  async function stopped(context, key, reason, message) {
    results.set(key, { ok: false, message });
    await repaint(context);
    return refused(reason, message);
  }

  /**
   * Writes the controls' changes to this maintainer's state comment.
   *
   * A save that lands clears the controls and holds the state it wrote, because
   * the comment is on GitHub and not in this document. A save that does not land
   * leaves every change where it is, so nothing typed is lost to a refusal.
   *
   * @param {EditorContext} context
   * @returns {Promise<StateWriteResult>}
   */
  async function save(context) {
    const key = keyOf(context.advisory);
    // A save while one is already going out is refused here, where the mark is
    // set. The write refuses it too, and a second call reaching that refusal
    // would take the mark the first call is still flying under with it.
    if (saving.has(key)) {
      return stopped(context, key, 'in-flight', globalThis.bghsa.state.IN_FLIGHT_MESSAGE);
    }
    const pending = editsFor(key);
    if (changedTracks(context.tracking, context.fingerprints, pending).length === 0) {
      // A staged confirmation with nothing behind it is work the maintainer did,
      // and a save that would carry only that carries nothing at all.
      const blocked = blockedTracks(context.tracking, context.fingerprints, pending);
      if (blocked.length > 0) {
        return stopped(context, key, 'unrecordable', unrecordedMessage(blocked));
      }
      return stopped(context, key, 'unchanged', UNCHANGED_MESSAGE);
    }
    const ref = context.advisory.ref;
    if (ref === null) return stopped(context, key, 'unreadable', UNREADABLE_MESSAGE);

    results.delete(key);
    // What the request carries, held from before it goes out. The store moves on
    // under a save, and what lands is what was captured here.
    const captured = writable(context.tracking, context.fingerprints, pending).diff;
    saving.add(key);
    /** @type {StateWriteResult} */
    let outcome;
    try {
      outcome = await globalThis.bghsa.state.writeState({
        ref,
        loadedSeq: context.merged.observedSeq,
        // The state a save remembers is at a sequence number the page has not
        // caught up with, and a rival write claiming that same number is state
        // this panel never showed. The holder is what tells the two apart.
        loadedHolder: globalThis.bghsa.state.holderOf(context.merged),
        changes: (envelope) => changesOf(context.tracking, context.fingerprints, pending, envelope),
        // What a clear would take away is judged against the state the write
        // builds on, which is the one its own fetch read. The state the panel
        // loaded with is older and can hold other fields.
        guard: (state, changes) => {
          const blocked = unclearable(state, changes);
          return blocked.length === 0
            ? null
            : { reason: 'unclearable', message: unclearableMessage(blocked) };
        },
        confirmed: pending.supersede === true,
        ...(context.at === undefined ? {} : { at: context.at }),
        ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
        ...(context.parseDocument === undefined ? {} : { parseDocument: context.parseDocument }),
      });
    } catch (error) {
      // Every failure the writer knows comes back as a result. One that reaches
      // here is the ground moving under it, and the panel says so rather than
      // holding "Writing to GitHub" until something else asks for a pass.
      saving.delete(key);
      return stopped(context, key, 'failed', failedMessage(error));
    }
    // Released by the call that set it, and before the pass below, so the pass
    // builds controls a maintainer can use again.
    saving.delete(key);

    const landed = outcome.ok ? afterWrite(outcome) : null;
    if (landed !== null) {
      release(key, captured);
      remember(key, landed);
    } else if (outcome.merged !== null) {
      remember(key, outcome.merged);
    }
    const saved = edits.has(key) ? SAVED_PENDING_MESSAGE : SAVED_MESSAGE;
    results.set(key, { ok: outcome.ok, message: outcome.ok ? saved : outcome.message });
    await repaint(context);
    return outcome;
  }

  /** How every surface builds an element. */
  const element = globalThis.bghsa.dom.element;

  /**
   * @param {Element} field
   * @returns {string} what a control holds. The live property is read where the
   *   host offers one, because that is what the maintainer typed or picked.
   */
  function valueOf(field) {
    const live = /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (field)).value;
    return typeof live === 'string' ? live : (field.getAttribute('value') ?? '');
  }

  /**
   * @param {Element} field
   * @returns {boolean} whether a checkbox is checked.
   */
  function isChecked(field) {
    const live = /** @type {{ checked?: unknown }} */ (/** @type {unknown} */ (field)).checked;
    return typeof live === 'boolean' ? live : field.hasAttribute('checked');
  }

  /** How every reader here reads an empty value as nothing. */
  const orNull = globalThis.bghsa.text.orNull;

  /**
   * @param {Element} node
   * @param {boolean} off
   * @returns {void}
   */
  function setDisabled(node, off) {
    if (off) {
      node.setAttribute('disabled', '');
      node.setAttribute('aria-disabled', 'true');
    } else {
      node.removeAttribute('disabled');
      node.removeAttribute('aria-disabled');
    }
  }

  /**
   * Reads a text control as it is typed and when the value settles. `change`
   * alone fires on blur, and a pass that rebuilds the panel between a keystroke
   * and the blur would take the half-typed value with it.
   *
   * @param {Element} field
   * @param {() => void} handler
   * @returns {void}
   */
  function onValue(field, handler) {
    field.addEventListener('input', handler);
    field.addEventListener('change', handler);
  }

  /**
   * @param {Document} doc
   * @param {string} label
   * @returns {{ field: Element, body: Element }} one labelled line of controls.
   */
  function fieldRow(doc, label) {
    const field = element(doc, 'div', 'd-flex flex-items-center flex-wrap mb-2 bghsa-field');
    field.append(element(doc, 'span', 'text-bold bghsa-field-label', label));
    const body = element(doc, 'div', 'flex-auto bghsa-field-body');
    field.append(body);
    return { field, body };
  }

  /**
   * A `select` over a known set of values. A stored value this reader does not
   * interpret is offered alongside them, so picking something else does not
   * hide what the advisory carries.
   *
   * @param {Document} doc
   * @param {string} className
   * @param {readonly string[]} values
   * @param {string | null} current
   * @param {string} blank What the empty option reads.
   * @returns {Element}
   */
  function selectControl(doc, className, values, current, blank) {
    const node = element(doc, 'select', `form-select select-sm ${className}`);
    const empty = element(doc, 'option', '', blank);
    empty.setAttribute('value', '');
    if (current === null) empty.setAttribute('selected', '');
    node.append(empty);
    const offered = current !== null && !values.includes(current) ? [...values, current] : values;
    for (const value of offered) {
      const option = element(doc, 'option', '', value);
      option.setAttribute('value', value);
      if (value === current) option.setAttribute('selected', '');
      node.append(option);
    }
    return node;
  }

  /**
   * @param {Document} doc
   * @param {string} className
   * @param {boolean} checked
   * @param {string} label
   * @returns {{ wrap: Element, box: Element }}
   */
  function checkboxControl(doc, className, checked, label) {
    const wrap = element(doc, 'label', 'd-inline-flex flex-items-center mr-3');
    const box = element(doc, 'input', className);
    box.setAttribute('type', 'checkbox');
    if (checked) box.setAttribute('checked', '');
    wrap.append(box);
    wrap.append(element(doc, 'span', 'ml-1', label));
    return { wrap, box };
  }

  /**
   * @param {Document} doc
   * @param {string} className
   * @param {string} type
   * @param {string | null} value
   * @param {string} placeholder
   * @returns {Element}
   */
  function textControl(doc, className, type, value, placeholder) {
    const node = element(doc, 'input', `form-control input-sm ${className}`);
    node.setAttribute('type', type);
    node.setAttribute('placeholder', placeholder);
    node.setAttribute('value', value ?? '');
    return node;
  }

  /**
   * The logins the panel offers as owners: the org members this page shows,
   * followed by the members this extension has seen on this organization's other
   * advisories. REQUIREMENTS.md section 6 has owners be org members, and a member
   * badge is what says a login is one. Membership is per organization, so a login
   * badged on another organization is not offered here.
   * A login outside the set is accepted when it is typed, and is flagged where it
   * is shown.
   *
   * Where no member of this organization has been seen, the advisory's
   * collaborators other than its reporter stand in, so the control is usable
   * before anything has been observed. GitHub counts the reporter as a
   * collaborator on the advisory they reported, which is why the reporter is left
   * out of that fallback.
   *
   * @param {EditorContext} context
   * @returns {string[]}
   */
  function ownerCandidates(context) {
    /** @type {string[]} */
    const candidates = [];
    const seen = globalThis.bghsa.members.known(context.advisory.ref);
    for (const login of [...context.derived.members, ...seen]) {
      if (!candidates.some((known) => known.toLowerCase() === login.toLowerCase())) {
        candidates.push(login);
      }
    }
    if (candidates.length > 0) return candidates;
    const reporter = context.advisory.reporter;
    return context.advisory.collaborators.filter(
      (login) => reporter === null || login.toLowerCase() !== reporter.toLowerCase()
    );
  }

  /**
   * Everything a surface needs to show one advisory's stored state and to write
   * it: what the advisory's state comments merge to, with a write from this
   * session preferred over the document it has not reached yet, the
   * fingerprints the confirmations bind to, the tracking view those two make,
   * and what the page derives.
   *
   * What the advisory says about the repository is taken here, on every surface
   * that assembles a context. A member badge says a login is an org member, and
   * a branch a pull request in the private fork targets or a maintainer asked
   * for a backport on is a branch the repository has. Both are read off the
   * advisory and both outlive it, so the pickers offer what any surface has
   * seen and not only what was opened by hand. Holding them is synchronous, so
   * the caller draws with them however slow storage is.
   *
   * @param {ParsedDetail} advisory
   * @param {object} [options]
   * @param {() => Promise<void> | void} [options.rerender] What runs a render
   *   pass on the surface asking, which is how it shows what a write left
   *   behind.
   * @param {import('../common/write.js').WriteFetch} [options.fetch]
   * @param {(html: string) => Document} [options.parseDocument]
   * @returns {Promise<EditorContext>}
   */
  async function contextFor(advisory, options = {}) {
    const merged = preferred(
      keyOf(advisory),
      globalThis.bghsa.merge.mergeSnapshots(advisory.comments)
    );
    const fingerprints = await globalThis.bghsa.tracking.fingerprints(advisory);
    const tracking = globalThis.bghsa.tracking.read(merged.state, fingerprints);
    const derived = globalThis.bghsa.derive.derive(advisory);
    globalThis.bghsa.members.remember(advisory.ref, derived.members);
    globalThis.bghsa.branches.remember(advisory.ref, [
      ...derived.patch.branches.map((patch) => patch.branch),
      ...tracking.backports,
    ]);
    return {
      advisory,
      derived,
      tracking,
      fingerprints,
      merged,
      ...(options.rerender === undefined ? {} : { rerender: options.rerender }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.parseDocument === undefined ? {} : { parseDocument: options.parseDocument }),
    };
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function triageField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Triage');
    const current = pick(editsFor(key).triage, context.tracking.triage);
    const control = selectControl(
      doc,
      'bghsa-triage',
      globalThis.bghsa.schema.TRIAGE_VALUES,
      current,
      'Not set'
    );
    control.addEventListener('change', () => {
      stage(key, { triage: orNull(valueOf(control)) });
      update();
    });
    body.append(control);
    return field;
  }

  /**
   * The branches the panel offers as backport targets: the release branches this
   * extension has seen on this repository, together with the ones this advisory
   * already carries, ordered by version descending. Version order puts
   * `release/2.10` before `release/2.9`; string order puts it after.
   *
   * A typed branch is accepted whether or not it is offered here, so a
   * repository whose branches this extension has never read still has a usable
   * control.
   *
   * @param {EditorContext} context
   * @returns {string[]}
   */
  function backportCandidates(context) {
    const branches = globalThis.bghsa.branches;
    const held = context.tracking.backports.filter((branch) => branches.isRelease(branch));
    return branches.order([...new Set([...branches.known(context.advisory.ref), ...held])]);
  }

  /**
   * @param {Document} doc
   * @param {string} key
   * @param {() => void} update
   * @param {ChipList} list
   * @returns {Element}
   */
  function chipListField(doc, key, update, list) {
    const { field, body } = fieldRow(doc, list.label);
    const chips = element(doc, 'div', `d-flex flex-wrap flex-items-center bghsa-${list.name}-list`);
    body.append(chips);

    /** @param {string} value @returns {boolean} whether the candidates offer it. */
    const offered = (value) =>
      list.candidates.some((candidate) => list.fold(candidate) === list.fold(value));

    const draw = () => {
      chips.textContent = '';
      for (const value of list.held()) {
        const chip = element(doc, 'span', `d-inline-flex flex-items-center mr-2 bghsa-${list.name}`);
        chip.append(element(doc, 'span', 'Label Label--secondary', value));
        if (list.unknown !== null && !offered(value)) {
          chip.append(
            element(
              doc,
              'span',
              `Label Label--secondary ml-1 bghsa-tone-attention bghsa-${list.name}-unknown`,
              list.unknown
            )
          );
        }
        const remove = element(doc, 'button', `btn-link ml-1 bghsa-${list.name}-remove`, 'Remove');
        remove.setAttribute('type', 'button');
        remove.setAttribute('aria-label', `Remove ${value} as ${list.noun}`);
        remove.addEventListener('click', () => {
          list.put(list.held().filter((one) => one !== value));
          draw();
          update();
        });
        chip.append(remove);
        chips.append(chip);
      }
    };
    draw();

    const typed = textControl(
      doc,
      `bghsa-${list.name}-input`,
      'text',
      list.drafts.get(key) ?? null,
      list.placeholder
    );
    onValue(typed, () => {
      const value = valueOf(typed);
      if (value === '') list.drafts.delete(key);
      else list.drafts.set(key, value);
    });
    const candidateList = element(doc, 'datalist', `bghsa-${list.name}-candidates`);
    candidateList.id = `bghsa-${list.name}-candidates-${key.replace(/[^a-z0-9-]/g, '-')}`;
    typed.setAttribute('list', candidateList.id);
    for (const value of list.candidates) {
      const option = element(doc, 'option', '');
      option.setAttribute('value', value);
      candidateList.append(option);
    }
    const add = element(doc, 'button', `btn btn-sm ml-2 bghsa-${list.name}-add`, 'Add');
    add.setAttribute('type', 'button');
    add.addEventListener('click', () => {
      const value = orNull(valueOf(typed));
      if (value === null) return;
      if (!list.held().some((one) => list.fold(one) === list.fold(value))) {
        list.put([...list.held(), value]);
      }
      typed.setAttribute('value', '');
      /** @type {{ value?: unknown }} */ (/** @type {unknown} */ (typed)).value = '';
      list.drafts.delete(key);
      draw();
      update();
    });
    body.append(typed);
    body.append(candidateList);
    body.append(add);
    return field;
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function ownersField(doc, context, key, update) {
    return chipListField(doc, key, update, {
      label: 'Owners',
      name: 'owner',
      noun: 'an owner',
      placeholder: 'login',
      candidates: ownerCandidates(context),
      fold: foldLogin,
      unknown: 'not a known member',
      drafts,
      held: () => pick(editsFor(key).owners, context.tracking.owners),
      put: (owners) => stage(key, { owners }),
    });
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function backportsField(doc, context, key, update) {
    return chipListField(doc, key, update, {
      label: 'Backport targets',
      name: 'backport',
      noun: 'a backport target',
      placeholder: 'release/2.1',
      candidates: backportCandidates(context),
      fold: (branch) => branch,
      unknown: null,
      drafts: branchDrafts,
      held: () => pick(editsFor(key).backports, context.tracking.backports),
      put: (backports) => stage(key, { backports }),
    });
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function embargoField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Embargo');
    const pending = editsFor(key);
    const inForce = pick(pending.embargo, context.tracking.embargo);
    const applies = checkboxControl(doc, 'bghsa-embargo', inForce, 'In force');
    const lift = textControl(
      doc,
      'bghsa-embargo-lift',
      'date',
      pick(pending.embargoLift, context.tracking.embargoLift),
      'yyyy-mm-dd'
    );
    applies.box.addEventListener('change', () => {
      stage(key, { embargo: isChecked(applies.box) });
      update();
    });
    onValue(lift, () => {
      stage(key, { embargoLift: orNull(valueOf(lift)) });
      update();
    });
    body.append(applies.wrap);
    body.append(element(doc, 'span', 'mr-1', 'Lifts'));
    body.append(lift);
    return field;
  }

  /**
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function closureField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Closed as');
    const pending = editsFor(key);
    const reason = pick(pending.closureReason, context.tracking.closureReason);
    const control = selectControl(
      doc,
      'bghsa-closure',
      globalThis.bghsa.schema.CLOSURE_REASONS,
      reason,
      'Not closed'
    );
    const duplicate = textControl(
      doc,
      'bghsa-closure-duplicate',
      'text',
      pick(pending.closureDuplicateOf, context.tracking.closureDuplicateOf),
      'GHSA-xxxx-xxxx-xxxx'
    );
    const showDuplicate = () => {
      setDisabled(duplicate, orNull(valueOf(control)) !== 'duplicate');
    };
    showDuplicate();
    control.addEventListener('change', () => {
      stage(key, { closureReason: orNull(valueOf(control)) });
      showDuplicate();
      update();
    });
    onValue(duplicate, () => {
      stage(key, { closureDuplicateOf: orNull(valueOf(duplicate)) });
      update();
    });
    body.append(control);
    body.append(element(doc, 'span', 'mx-1', 'of'));
    body.append(duplicate);
    return field;
  }

  /**
   * The three confirmations. A checkbox stands for the record: checking it
   * records this maintainer against the value on the page, and clearing it takes
   * the record away. A value the page did not give cannot be confirmed, so its
   * checkbox is unavailable and says so.
   *
   * @param {Document} doc
   * @param {EditorContext} context
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function confirmationField(doc, context, key, update) {
    const { field, body } = fieldRow(doc, 'Confirmed');
    const pending = editsFor(key);
    for (const track of globalThis.bghsa.tracking.CONFIRMATION_TRACKS) {
      const stored = context.tracking[track.key].status === 'confirmed';
      const checked = pick(pending.confirm?.[track.key], stored);
      const control = checkboxControl(
        doc,
        `bghsa-confirm bghsa-confirm-${track.key}`,
        checked,
        track.name
      );
      if (context.fingerprints[track.key] === null && !stored) {
        setDisabled(control.box, true);
        control.wrap.append(
          element(doc, 'span', 'ml-1 bghsa-confirmation-note', '(the value on the page went unread)')
        );
      }
      control.box.addEventListener('change', () => {
        stageConfirmation(key, track.key, isChecked(control.box));
        update();
      });
      body.append(control.wrap);
    }
    return field;
  }

  /**
   * @param {Document} doc
   * @param {string} key
   * @param {() => void} update
   * @returns {Element}
   */
  function supersedeField(doc, key, update) {
    const { field, body } = fieldRow(doc, 'Confirmation');
    const control = checkboxControl(
      doc,
      'bghsa-supersede',
      editsFor(key).supersede === true,
      SUPERSEDE_LABEL
    );
    control.box.addEventListener('change', () => {
      stage(key, { supersede: isChecked(control.box) });
      update();
    });
    body.append(control.wrap);
    return field;
  }

  /**
   * The editing controls for one advisory, and the save that writes them. A pass
   * builds these again from the changes the store holds, so a change survives
   * GitHub replacing what surrounds the panel.
   *
   * @param {Document} doc
   * @param {EditorContext} context
   * @returns {Element}
   */
  function buildEditor(doc, context) {
    const key = keyOf(context.advisory);
    // Building the editor is the panel taking up this advisory, and what a
    // departure from it is judged against.
    panelShows(key);
    prune(key, context.tracking);
    const box = element(doc, 'div', 'Box-row bghsa-editor');

    if (context.merged.readOnly) {
      box.append(element(doc, 'div', 'flash flash-warn bghsa-read-only', READ_ONLY_MESSAGE));
      return box;
    }

    const disclosure = element(doc, 'details', 'bghsa-editor-details');
    if (opened.has(key)) disclosure.setAttribute('open', '');
    // A Primer button, so the disclosure reads as a control and not as a line
    // of bold text with a triangle beside it. It stays a `summary`, so the
    // native disclosure semantics and the expanded state still hold.
    const summary = element(doc, 'summary', 'btn btn-sm bghsa-editor-summary', 'Edit tracking state');
    summary.addEventListener('click', () => {
      if (opened.has(key)) opened.delete(key);
      else opened.add(key);
    });
    disclosure.append(summary);

    const controls = element(doc, 'div', 'pt-2 bghsa-controls');
    disclosure.append(controls);

    // The result this panel is built for, which is the one the flash below
    // carries. The note names anything that lands after it.
    const shown = results.get(key);

    // Built before the controls so their handlers can call it, and given its work
    // once the nodes it reports on are in hand.
    /** @type {{ run: () => void }} */
    const hook = { run: () => {} };
    const update = () => hook.run();

    controls.append(triageField(doc, context, key, update));
    controls.append(ownersField(doc, context, key, update));
    controls.append(backportsField(doc, context, key, update));
    controls.append(embargoField(doc, context, key, update));
    controls.append(closureField(doc, context, key, update));
    controls.append(confirmationField(doc, context, key, update));
    if (context.merged.confirmationRequired) controls.append(supersedeField(doc, key, update));

    const bar = element(doc, 'div', 'd-flex flex-items-center flex-wrap mt-2 bghsa-save-row');
    const saveButton = element(doc, 'button', 'btn btn-sm btn-primary bghsa-save', 'Save');
    saveButton.setAttribute('type', 'button');
    const discardButton = element(doc, 'button', 'btn btn-sm ml-2 bghsa-discard', 'Discard changes');
    discardButton.setAttribute('type', 'button');
    const note = element(doc, 'span', 'ml-2 bghsa-save-note');
    bar.append(saveButton);
    bar.append(discardButton);
    bar.append(note);
    controls.append(bar);

    hook.run = () => {
      const flight = saving.has(key);
      const pending = editsFor(key);
      const names = changedTracks(context.tracking, context.fingerprints, pending);
      const blocked = blockedTracks(context.tracking, context.fingerprints, pending);
      const held = heldTracks(context.tracking, pending);
      /** @type {string[]} */
      const said = [];
      if (names.length > 0) said.push(`Unsaved changes: ${names.join(', ')}.`);
      if (blocked.length > 0) said.push(unrecordedNote(blocked));
      for (const field of held) {
        const sentence = HELD_NOTES[field];
        if (sentence !== undefined) said.push(sentence);
      }
      // What a save did lands in the panel as a flash on the next pass. A result
      // this panel was not built for is one no pass has shown, so the note
      // carries it: the pass may be the thing that failed.
      const result = results.get(key);
      if (result !== undefined && result !== shown) said.push(result.message);
      note.textContent = flight
        ? WRITING_MESSAGE
        : said.length === 0
          ? 'No unsaved changes.'
          : said.join(' ');
      setDisabled(saveButton, flight || names.length === 0);
      setDisabled(
        discardButton,
        flight || (names.length === 0 && blocked.length === 0 && held.length === 0)
      );
      // Every control is held still while the request is out, whether this is
      // the pass that sent it or a pass the page asked for in the meantime, and
      // the flight gives back what it took once it settles. A control already
      // off for a reason of its own is left alone.
      if (flight) {
        for (const node of controls.querySelectorAll('input, select, button')) {
          if (node.hasAttribute('disabled')) continue;
          node.setAttribute(FLIGHT_MARK, '');
          setDisabled(node, true);
        }
      } else {
        for (const node of controls.querySelectorAll(`[${FLIGHT_MARK}]`)) {
          node.removeAttribute(FLIGHT_MARK);
          setDisabled(node, false);
        }
      }
    };
    hook.run();

    saveButton.addEventListener('click', () => {
      // The save marks the advisory before it awaits anything, so the controls
      // this press leaves behind read the flight from the same place a pass does,
      // and they are read again once it settles, because the pass that would
      // replace them can be the thing that went wrong.
      void save(context).then(update, update);
      update();
    });
    discardButton.addEventListener('click', () => {
      discard(key);
      void context.rerender?.();
    });

    if (shown !== undefined) {
      controls.append(
        element(
          doc,
          'div',
          `flash mt-2 bghsa-save-result ${shown.ok ? 'flash-success' : 'flash-warn'}`,
          shown.message
        )
      );
    }

    box.append(disclosure);
    return box;
  }

  const exported = {
    LEAVE_MESSAGE,
    PENDING_FIELDS,
    READ_ONLY_MESSAGE,
    SAVED_MESSAGE,
    SAVED_PENDING_MESSAGE,
    WRITING_MESSAGE,
    UNCHANGED_MESSAGE,
    UNREADABLE_MESSAGE,
    SUPERSEDE_LABEL,
    edits,
    written,
    results,
    opened,
    saving,
    drafts,
    branchDrafts,
    keyOf,
    editsFor,
    stage,
    stageConfirmation,
    discard,
    release,
    staged,
    differences,
    HELD_NOTES,
    heldTracks,
    writable,
    blockedTracks,
    unrecordedNote,
    unrecordedMessage,
    changedTracks,
    prune,
    pendingOn,
    anyPending,
    showing,
    panelShows,
    leavesPage,
    armNavigationWarning,
    optional,
    changesOf,
    NESTED_TRACKS,
    unknownFields,
    unclearable,
    unclearableMessage,
    remember,
    preferred,
    afterWrite,
    save,
    ownerCandidates,
    backportCandidates,
    contextFor,
    buildEditor,
  };

  globalThis.bghsa.edit = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
