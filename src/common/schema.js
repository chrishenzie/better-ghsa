'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

/** The schema version this writer stamps on every snapshot it writes. */
const SCHEMA_VERSION = '1.0';

/** The schema major version this reader interprets. */
const SCHEMA_MAJOR = 1;

/** The fixed summary text of a state comment's `details` block. */
const STATE_COMMENT_SUMMARY = 'Better GHSA tracking state';

/** Triage values this reader interprets. @type {readonly string[]} */
const TRIAGE_VALUES = ['evaluating', 'awaiting reporter', 'awaiting maintainer input'];

/** Closure reasons this reader interprets. @type {readonly string[]} */
const CLOSURE_REASONS = [
  'duplicate',
  'not a vulnerability',
  'not reproducible',
  'working as intended',
  'out of scope',
  'no reporter response',
  'withdrawn by reporter',
];

/** How many hex characters of the digest a fingerprint keeps. */
const FINGERPRINT_LENGTH = 12;

/**
 * @typedef {object} SnapshotReport
 * @property {string} raw The JSON source recovered from the fenced block.
 * @property {unknown} parsed The parsed payload, or null when it did not parse.
 * @property {string | null} version The `betterGhsa` schema version.
 * @property {number | null} major The schema major, when `version` is a version.
 * @property {boolean} schemaSupported Whether this reader interprets that major.
 * @property {number | null} seq The ordering claim.
 * @property {string | null} by The login the snapshot names as its writer.
 * @property {boolean} ordered Whether the envelope carries an ordering claim.
 * @property {boolean} valid Whether the payload passed validation.
 * @property {string[]} problems Why the snapshot is not usable, in display order.
 * @property {string[]} unrecognized Known enum fields holding a value this
 *   reader does not interpret. Their values are displayed raw and carried
 *   forward.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @param {string[]} problems
 * @returns {void}
 */
function requireStringArray(payload, key, problems) {
  const value = payload[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    problems.push(`${key} is not an array of strings`);
  }
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} key
 * @param {string[]} problems
 * @param {string} [prefix] The path to `payload` within the snapshot.
 * @returns {void}
 */
function requireString(payload, key, problems, prefix) {
  const value = payload[key];
  if (value === undefined) return;
  if (typeof value !== 'string') {
    problems.push(`${prefix === undefined ? '' : `${prefix}.`}${key} is not a string`);
  }
}

/**
 * Checks the type of every field this reader knows. Unknown fields pass, and so
 * does an unrecognized value in a known enum field.
 *
 * @param {Record<string, unknown>} payload
 * @returns {{ problems: string[], unrecognized: string[] }}
 */
function validateSnapshot(payload) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const unrecognized = [];

  if (typeof payload['betterGhsa'] !== 'string') problems.push('betterGhsa is not a string');
  for (const key of ['by', 'at', 'triage', 'triageSince']) requireString(payload, key, problems);
  for (const key of ['owners', 'backports']) requireStringArray(payload, key, problems);

  const triage = payload['triage'];
  if (typeof triage === 'string' && !TRIAGE_VALUES.includes(triage)) unrecognized.push('triage');

  const confirmed = payload['confirmed'];
  if (confirmed !== undefined) {
    if (!isPlainObject(confirmed)) {
      problems.push('confirmed is not an object');
    } else {
      for (const [track, record] of Object.entries(confirmed)) {
        if (!isPlainObject(record)) {
          problems.push(`confirmed.${track} is not an object`);
          continue;
        }
        for (const key of ['by', 'at', 'fp']) {
          requireString(record, key, problems, `confirmed.${track}`);
        }
      }
    }
  }

  const embargo = payload['embargo'];
  if (embargo !== undefined) {
    if (!isPlainObject(embargo)) problems.push('embargo is not an object');
    else requireString(embargo, 'lift', problems, 'embargo');
  }

  const closure = payload['closure'];
  if (closure !== undefined) {
    if (!isPlainObject(closure)) {
      problems.push('closure is not an object');
    } else {
      for (const key of ['reason', 'duplicateOf']) {
        requireString(closure, key, problems, 'closure');
      }
      const reason = closure['reason'];
      if (typeof reason === 'string' && !CLOSURE_REASONS.includes(reason)) {
        unrecognized.push('closure.reason');
      }
    }
  }

  return { problems, unrecognized };
}

/**
 * Reads the snapshot a state comment carries. The envelope, `seq` and `by`, is
 * read independently of the payload, so ordering holds for a snapshot whose
 * payload is invalid.
 *
 * @param {string} raw The JSON source from the fenced block.
 * @returns {SnapshotReport}
 */
function readSnapshot(raw) {
  /** @type {SnapshotReport} */
  const report = {
    raw,
    parsed: null,
    version: null,
    major: null,
    schemaSupported: false,
    seq: null,
    by: null,
    ordered: false,
    valid: false,
    problems: [],
    unrecognized: [],
  };

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    report.problems.push('the fenced block does not parse as JSON');
    return report;
  }
  if (!isPlainObject(parsed)) {
    report.problems.push('the fenced block is not a JSON object');
    return report;
  }
  report.parsed = parsed;

  const version = parsed['betterGhsa'];
  if (typeof version === 'string') {
    report.version = version;
    const major = /^(\d+)\./.exec(version);
    if (major !== null) report.major = Number(major[1]);
  }
  report.schemaSupported = report.major === SCHEMA_MAJOR;

  const seq = parsed['seq'];
  if (typeof seq === 'number' && Number.isFinite(seq)) {
    report.seq = seq;
    report.ordered = true;
  } else {
    report.problems.push('seq is absent or is not a number');
  }

  const by = parsed['by'];
  if (typeof by === 'string') report.by = by;

  const checked = validateSnapshot(parsed);
  report.unrecognized = checked.unrecognized;
  report.problems.push(...checked.problems);
  report.valid = report.ordered && checked.problems.length === 0;

  return report;
}

/**
 * The form a value takes before it is fingerprinted: CRLF becomes LF, each
 * line loses its trailing whitespace, leading and trailing blank lines go, and
 * the result is in Unicode NFC.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
function normalize(value) {
  if (typeof value !== 'string') return '';
  const lines = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n').normalize('NFC');
}

/**
 * The fingerprint of a source value: the first 12 hex characters of the
 * SHA-256 of its normalized form. It detects change and is not a security
 * boundary.
 *
 * @param {string | null | undefined} value Raw markdown from a metadata form
 *   field, not rendered text.
 * @returns {Promise<string>}
 */
async function fingerprint(value) {
  const bytes = new TextEncoder().encode(normalize(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, FINGERPRINT_LENGTH);
}

/**
 * The source value the scoring fingerprint covers. A real advisory carries a
 * severity or a CVSS vector and not both, so each half is labelled and an
 * absent half is written as the empty string. A null half and an empty half
 * therefore fingerprint alike.
 *
 * @param {string | null | undefined} severity The stored severity selection.
 * @param {string | null | undefined} vector The CVSS vector.
 * @returns {string}
 */
function scoringSource(severity, vector) {
  return `severity=${normalize(severity)}\ncvss=${normalize(vector)}`;
}

/**
 * @param {string | null | undefined} severity
 * @param {string | null | undefined} vector
 * @returns {Promise<string>}
 */
function scoringFingerprint(severity, vector) {
  return fingerprint(scoringSource(severity, vector));
}

globalThis.bghsa.schema = {
  SCHEMA_VERSION,
  SCHEMA_MAJOR,
  STATE_COMMENT_SUMMARY,
  TRIAGE_VALUES,
  CLOSURE_REASONS,
  FINGERPRINT_LENGTH,
  isPlainObject,
  validateSnapshot,
  readSnapshot,
  normalize,
  fingerprint,
  scoringSource,
  scoringFingerprint,
};

if (typeof module !== 'undefined') {
  module.exports = globalThis.bghsa.schema;
}
