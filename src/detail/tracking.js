'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('../common/schema.js');
  require('../common/merge.js');
}

/**
 * @typedef {import('../common/parse-detail.js').ParsedDetail} ParsedDetail
 * @typedef {import('../common/merge.js').MergedState} MergedState
 */

/**
 * Where one confirmation track stands against the value the page carries now.
 *
 * `drifted` is a confirmation whose fingerprint no longer matches that value.
 * REQUIREMENTS.md section 6 reverts the track to unconfirmed there and keeps
 * who confirmed a different value and when, which is what the record still
 * holds. `unreadable` is a source value the parser did not find, where there is
 * nothing to compare the fingerprint against.
 *
 * @typedef {'confirmed' | 'unconfirmed' | 'drifted' | 'unreadable'} ConfirmationStatus
 */

/**
 * @typedef {object} Confirmation
 * @property {ConfirmationStatus} status
 * @property {string | null} by The login the record names.
 * @property {string | null} at The time the record names.
 */

/**
 * The fingerprints of the values the confirmations bind to, computed from the
 * metadata form source values. A value the parser did not read is null, and
 * its track cannot be judged.
 *
 * The scoring halves are labelled inside the fingerprinted source, so an unset
 * severity and an unset vector are a scoring state like any other and always
 * fingerprint to something.
 *
 * @typedef {object} Fingerprints
 * @property {string | null} title
 * @property {string | null} description
 * @property {string | null} scoring
 */

/**
 * The stored tracks of REQUIREMENTS.md section 6, read out of one snapshot.
 * Every value is displayed as it stands, so a value this reader does not
 * interpret reaches the panel raw.
 *
 * @typedef {object} TrackingView
 * @property {string | null} triage
 * @property {string | null} triageSince
 * @property {string[]} owners
 * @property {string[]} backports
 * @property {boolean} embargo Whether an embargo applies.
 * @property {string | null} embargoLift
 * @property {string | null} closureReason
 * @property {string | null} closureDuplicateOf
 * @property {Confirmation} title
 * @property {Confirmation} description
 * @property {Confirmation} scoring
 */

/**
 * @param {Record<string, unknown> | null} record
 * @param {string} key
 * @returns {string | null} the field's value, or null where it is not a string
 *   with content.
 */
function stringField(record, key) {
  const value = record === null ? undefined : record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * @param {Record<string, unknown> | null} record
 * @param {string} key
 * @returns {string[]} the strings with content the field holds.
 */
function stringArrayField(record, key) {
  const value = record === null ? undefined : record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * @param {Record<string, unknown> | null} record
 * @param {string} key
 * @returns {Record<string, unknown> | null}
 */
function objectField(record, key) {
  const value = record === null ? undefined : record[key];
  return globalThis.bghsa.schema.isPlainObject(value) ? value : null;
}

/**
 * Where one confirmation stands. A record carrying no fingerprint confirms
 * nothing, because nothing says what it confirmed.
 *
 * @param {Record<string, unknown> | null} state
 * @param {string} track
 * @param {string | null} current The fingerprint of the value on the page.
 * @returns {Confirmation}
 */
function confirmationOf(state, track, current) {
  const record = objectField(objectField(state, 'confirmed'), track);
  const fingerprint = stringField(record, 'fp');
  if (fingerprint === null) return { status: 'unconfirmed', by: null, at: null };
  const by = stringField(record, 'by');
  const at = stringField(record, 'at');
  if (current === null) return { status: 'unreadable', by, at };
  return { status: fingerprint === current ? 'confirmed' : 'drifted', by, at };
}

/**
 * The tracks one snapshot holds, judged against the values on the page.
 *
 * @param {Record<string, unknown> | null} state The merged snapshot.
 * @param {Fingerprints} fingerprints
 * @returns {TrackingView}
 */
function read(state, fingerprints) {
  const embargo = objectField(state, 'embargo');
  const closure = objectField(state, 'closure');
  return {
    triage: stringField(state, 'triage'),
    triageSince: stringField(state, 'triageSince'),
    owners: stringArrayField(state, 'owners'),
    backports: stringArrayField(state, 'backports'),
    embargo: embargo !== null,
    embargoLift: stringField(embargo, 'lift'),
    closureReason: stringField(closure, 'reason'),
    closureDuplicateOf: stringField(closure, 'duplicateOf'),
    title: confirmationOf(state, 'title', fingerprints.title),
    description: confirmationOf(state, 'description', fingerprints.description),
    scoring: confirmationOf(state, 'scoring', fingerprints.scoring),
  };
}

/**
 * @returns {TrackingView} the view of an advisory no snapshot holds state for.
 */
function untracked() {
  return read(null, { title: null, description: null, scoring: null });
}

/**
 * The fingerprints of the values a confirmation binds to. The inputs are the
 * metadata form source values, which is the raw markdown, not rendered text.
 *
 * @param {ParsedDetail} advisory
 * @returns {Promise<Fingerprints>}
 */
async function fingerprints(advisory) {
  const schema = globalThis.bghsa.schema;
  const [title, description, scoring] = await Promise.all([
    advisory.title === null ? null : schema.fingerprint(advisory.title),
    advisory.description === null ? null : schema.fingerprint(advisory.description),
    schema.scoringFingerprint(advisory.severityField, advisory.cvssV3),
  ]);
  return { title, description, scoring };
}

/**
 * The tracking state one advisory page carries.
 *
 * @param {ParsedDetail} advisory
 * @param {MergedState} merged
 * @returns {Promise<TrackingView>}
 */
async function readAdvisory(advisory, merged) {
  return read(merged.state, await fingerprints(advisory));
}

globalThis.bghsa.tracking = { read, untracked, fingerprints, readAdvisory };

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.tracking;
}
