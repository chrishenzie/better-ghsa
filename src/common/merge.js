'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependency is named here.
if (typeof require === 'function') require('./schema.js');

/**
 * A state comment as the merge reads it: the comment it sits in, whether its
 * author's snapshots count, and the snapshot itself.
 *
 * @typedef {object} SnapshotSource
 * @property {string} id The numeric comment id.
 * @property {string} elementId The `advisory-comment-{id}` element id.
 * @property {string | null} author
 * @property {boolean} trusted
 * @property {import('./schema.js').SnapshotReport | null} stateComment
 */

/**
 * @typedef {'not a snapshot' | 'untrusted' | 'invalid payload' | 'unsupported schema'} WarningKind
 */

/**
 * @typedef {object} MergeWarning
 * @property {WarningKind} kind
 * @property {string} commentId
 * @property {string} elementId
 * @property {string | null} author
 * @property {string} message What the chip carries as a tooltip, and empty
 *   where the chip's own words are the whole of it.
 */

/**
 * @typedef {object} MergedState
 * @property {Record<string, unknown> | null} state The payload of the snapshot
 *   that holds current state, unknown fields included.
 * @property {SnapshotSource | null} source The comment that payload came from.
 * @property {number | null} seq The ordering claim of that snapshot.
 * @property {number} observedSeq The highest ordering claim on the advisory,
 *   counting snapshots this merge excluded from state.
 * @property {number} nextSeq The ordering claim the next write carries, one
 *   above the highest observed. Every claim read is at most
 *   `schema.MAX_SEQ`, so this is exact and outranks every claim on the
 *   advisory.
 * @property {MergeWarning[]} warnings
 * @property {boolean} readOnly Whether a trusted snapshot names a schema major
 *   this reader does not interpret. Nothing else puts an advisory read-only.
 * @property {boolean} confirmationRequired Whether an excluded snapshot still
 *   carries an ordering claim, which makes the next write take one explicit
 *   confirmation.
 */

(() => {
  /**
   * The login a tie is resolved on. Trust is decided on the comment's author, so
   * that login ranks the snapshot, and the login the payload names stands in when
   * the page did not give one.
   *
   * @param {SnapshotSource} source
   * @returns {string}
   */
  function loginOf(source) {
    return source.author ?? source.stateComment?.by ?? '';
  }

  /**
   * Orders two logins by code point, negative when `left` sorts first. `<` and
   * `>` on strings compare UTF-16 code units, which put every code point above
   * the basic plane below `\uE000` through `\uFFFF`; section 7 puts the
   * tie-break on code point order. GitHub logins are ASCII, where the two orders
   * agree.
   *
   * @param {string} left
   * @param {string} right
   * @returns {number}
   */
  function compareLogins(left, right) {
    const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
    const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
    const shared = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < shared; index += 1) {
      const leftPoint = leftPoints[index] ?? 0;
      const rightPoint = rightPoints[index] ?? 0;
      if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    }
    return leftPoints.length - rightPoints.length;
  }

  /**
   * Whether `candidate` holds state over `holder`. The higher `seq` wins, and a
   * tie goes to the greater login in code point order. The direction is
   * arbitrary; what it buys is that every reader resolves a tie alike.
   *
   * @param {SnapshotSource} candidate
   * @param {SnapshotSource} holder
   * @returns {boolean}
   */
  function outranks(candidate, holder) {
    const candidateSeq = candidate.stateComment?.seq ?? 0;
    const holderSeq = holder.stateComment?.seq ?? 0;
    if (candidateSeq !== holderSeq) return candidateSeq > holderSeq;
    return compareLogins(loginOf(candidate), loginOf(holder)) > 0;
  }

  /**
   * @param {MergeWarning[]} warnings
   * @param {WarningKind} kind
   * @param {SnapshotSource} source
   * @param {string} message What the chip's tooltip reads, or empty for no
   *   tooltip at all.
   * @returns {void}
   */
  function warn(warnings, kind, source, message) {
    warnings.push({
      kind,
      commentId: source.id,
      elementId: source.elementId,
      author: source.author,
      message,
    });
  }

  /**
   * Resolves the state comments on one advisory into the state they agree on.
   *
   * A snapshot whose fence does not parse, or whose `seq` is absent or is not a
   * number, carries no ordering claim: it is warned on and writing continues. A
   * snapshot whose `seq` reads and whose payload fails validation is excluded
   * from state, is warned on by name, and makes the next write take one explicit
   * confirmation.
   *
   * @param {SnapshotSource[]} sources
   * @returns {MergedState}
   */
  function mergeSnapshots(sources) {
    /** @type {MergeWarning[]} */
    const warnings = [];
    /** @type {SnapshotSource | null} */
    let holder = null;
    let observedSeq = 0;
    let readOnly = false;
    let confirmationRequired = false;

    for (const source of sources) {
      const report = source.stateComment;
      if (report === null) continue;

      if (!report.ordered) {
        warn(warnings, 'not a snapshot', source, report.problems.join('; '));
        continue;
      }

      observedSeq = Math.max(observedSeq, report.seq ?? 0);

      if (!source.trusted) {
        // The chip is the whole of it: what it says the reader can act on, and
        // nothing about the comment it sits on is a fact a tooltip would add.
        warn(warnings, 'untrusted', source, '');
        continue;
      }

      // A payload naming a major this reader does not read is not one this
      // reader's field rules can judge, so the version is settled first. The
      // gate reads a major only where one parsed, so a payload that names no
      // readable version falls through to validation, which is where a missing
      // or malformed `betterGhsa` is reported.
      if (!report.schemaSupported) {
        readOnly = true;
        // The chip beside this message already says the snapshot comes from a
        // newer extension, so the version is the one fact left to carry.
        warn(
          warnings,
          'unsupported schema',
          source,
          `Schema version ${report.version ?? 'none'}`
        );
        continue;
      }

      if (!report.valid) {
        confirmationRequired = true;
        warn(warnings, 'invalid payload', source, report.problems.join('; '));
        continue;
      }

      if (holder === null || outranks(source, holder)) holder = source;
    }

    const state =
      holder === null
        ? null
        : /** @type {Record<string, unknown>} */ (holder.stateComment?.parsed ?? null);

    return {
      state,
      source: holder,
      seq: holder?.stateComment?.seq ?? null,
      observedSeq,
      nextSeq: observedSeq + 1,
      warnings,
      readOnly,
      confirmationRequired,
    };
  }

  /**
   * Writes `value` as an own field of `target` under `key`, whatever the key
   * reads. Assignment to `__proto__` stores no field and sets the object's
   * prototype from the value, so a snapshot carrying that key would lose it and
   * the result would answer for fields it never held.
   *
   * @param {Record<string, unknown>} target
   * @param {string} key
   * @param {unknown} value
   * @returns {void}
   */
  function define(target, key, value) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  /**
   * A copy of `value` sharing no object with it. A written snapshot is built
   * from the parsed report the merge holds and from the caller's changes; a
   * copy is what keeps a later change to one of them out of the other.
   *
   * Plain objects and arrays are copied through. Every other value a JSON
   * payload holds is a primitive and stands as it is.
   *
   * @param {unknown} value
   * @returns {unknown}
   */
  function clone(value) {
    const schema = globalThis.bghsa.schema;
    if (Array.isArray(value)) return value.map((entry) => clone(entry));
    if (!schema.isPlainObject(value)) return value;
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, entry] of Object.entries(value)) define(copy, key, clone(entry));
    return copy;
  }

  /**
   * Copies `base` forward with `changes` applied. A field `changes` does not name
   * survives untouched whether or not this reader knows it, an object is merged
   * key by key so an unknown field inside it survives too, and null removes a
   * field.
   *
   * @param {Record<string, unknown>} base
   * @param {Record<string, unknown>} changes
   * @returns {Record<string, unknown>}
   */
  function applyChanges(base, changes) {
    const schema = globalThis.bghsa.schema;
    const merged = /** @type {Record<string, unknown>} */ (clone(base));
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      if (value === null) {
        delete merged[key];
        continue;
      }
      const existing = Object.hasOwn(merged, key) ? merged[key] : undefined;
      define(
        merged,
        key,
        schema.isPlainObject(value) && schema.isPlainObject(existing)
          ? applyChanges(existing, value)
          : clone(value)
      );
    }
    return merged;
  }

  /**
   * The payload of the next write: the merged state carried forward, the caller's
   * changes applied, and the envelope stamped. It shares no object with `current`
   * or with `changes`.
   *
   * @param {Record<string, unknown> | null} current
   * @param {Record<string, unknown>} changes
   * @param {{ by: string, at: string, seq: number }} envelope
   * @returns {Record<string, unknown>}
   */
  function nextSnapshot(current, changes, envelope) {
    const schema = globalThis.bghsa.schema;
    const merged = applyChanges(current ?? {}, changes);
    merged['betterGhsa'] = schema.SCHEMA_VERSION;
    merged['seq'] = envelope.seq;
    merged['by'] = envelope.by;
    merged['at'] = envelope.at;
    return merged;
  }

  const exported = { compareLogins, mergeSnapshots, applyChanges, nextSnapshot };

  globalThis.bghsa.merge = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
