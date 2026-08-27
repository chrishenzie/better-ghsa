'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./corpus.js');
  require('./stats.js');
}

/**
 * What one advisory contributes to the export.
 *
 * Every field is either read off the advisory or read off the list row that
 * named it, so a member no advisory read backs still exports a line. `read`
 * says which it was, and the timings on an unread member are blank rather than
 * zero.
 *
 * @typedef {Record<string, string | number | null>} CsvRow
 */

/**
 * @typedef {object} DownloadOptions
 * @property {typeof globalThis.Blob} [Blob]
 * @property {(blob: Blob) => string} [createObjectURL]
 * @property {(url: string) => void} [revokeObjectURL]
 */

(() => {
  /** What the export is served as. */
  const MIME = 'text/csv;charset=utf-8';

  /**
   * The columns, in the order they are written.
   *
   * A duration is written in milliseconds, which is what the statistics measure
   * in. It is the value itself and not a rounding of it, so a spreadsheet
   * dividing it gets whatever unit the reader wants.
   *
   * @type {readonly string[]}
   */
  const COLUMNS = [
    'ghsa_id',
    'title',
    'state',
    'severity',
    'closure_reason',
    'reported_at',
    'month',
    'first_response_ms',
    'report_to_draft_ms',
    'read',
    'observed_at',
  ];

  /**
   * The characters a spreadsheet reads as the start of a formula.
   *
   * A title and a closure reason are text this extension did not write: a
   * reporter names their own advisory, and a closure reason is whatever a
   * maintainer's extension stored. A field opening with one of these is a
   * formula the moment the file is opened, so the field is quoted and a text
   * marker is put in front of it. Nothing in this export legitimately opens
   * with one, so no value is lost to the marker.
   */
  const FORMULA_LEAD = /^[=+\-@\t\r]/;

  /** What a field opening as a formula is prefixed with. */
  const FORMULA_GUARD = "'";

  /** RFC 4180 ends a record with a carriage return and a line feed. */
  const NEWLINE = '\r\n';

  /**
   * @param {string | number | null} value
   * @returns {string} that value as one CSV field.
   */
  function field(value) {
    if (value === null) return '';
    const text = typeof value === 'number' ? String(value) : value;
    const guarded = FORMULA_LEAD.test(text) ? `${FORMULA_GUARD}${text}` : text;
    if (guarded === text && !/[",\r\n]/.test(text)) return text;
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  /**
   * @param {readonly (string | number | null)[]} values
   * @returns {string}
   */
  function line(values) {
    return values.map(field).join(',');
  }

  /**
   * @param {number | null} at
   * @returns {string | null} that instant as an ISO stamp, and null for none.
   */
  function stampOf(at) {
    return at === null ? null : new Date(at).toISOString();
  }

  /**
   * One advisory as the export holds it.
   *
   * @param {import('./corpus.js').CorpusMember} member
   * @returns {CsvRow}
   */
  function rowOf(member) {
    const stats = globalThis.bghsa.stats;
    const advisory = member.advisory;
    const state = advisory?.state ?? member.row.state ?? member.state;
    return {
      ghsa_id: member.ghsaId,
      title: advisory?.title ?? member.row.title,
      state: state === null ? null : state.toLowerCase(),
      severity: advisory?.severity ?? member.row.severity,
      closure_reason: advisory === null ? null : stats.closureReasonOf(advisory),
      reported_at: advisory?.reportedAt ?? member.row.openedAt,
      month: stats.monthOf(advisory?.reportedAt ?? member.row.openedAt),
      first_response_ms: stats.durationOf(advisory, stats.firstResponseAt),
      report_to_draft_ms: stats.durationOf(advisory, stats.draftAt),
      read: advisory === null ? 'no' : 'yes',
      observed_at: stampOf(member.observedAt),
    };
  }

  /**
   * The corpus as a CSV, built here in the page from what the crawl and the
   * reads already hold. Nothing is sent anywhere and nothing is fetched.
   *
   * @param {import('./corpus.js').Corpus} held
   * @returns {string}
   */
  function toCsv(held) {
    const lines = [line(COLUMNS)];
    for (const member of held.members) {
      const row = rowOf(member);
      lines.push(line(COLUMNS.map((column) => row[column] ?? null)));
    }
    return `${lines.join(NEWLINE)}${NEWLINE}`;
  }

  /**
   * @param {{ owner: string, repo: string }} ref
   * @param {number} at
   * @returns {string} what the file is offered under. The repository and the day
   *   are in the name, because a maintainer exporting two repositories on two
   *   days wants four files and not one asked about four times.
   */
  function filenameFor(ref, at) {
    const day = new Date(at).toISOString().slice(0, 10);
    const name = `${ref.owner}-${ref.repo}`.replace(/[^A-Za-z0-9._-]+/g, '-');
    return `${name}-advisories-${day}.csv`;
  }

  /**
   * Hands the file to the browser: a blob made in the page, a URL for it, and an
   * anchor clicked to take it. The anchor is put in the document, pressed, and
   * taken out again, because a click on an element outside the document does not
   * start a download.
   *
   * The URL is released on the next turn. Releasing it in the same turn as the
   * press has been known to reach the browser before the download does.
   *
   * @param {Document} doc
   * @param {string} name
   * @param {string} text
   * @param {DownloadOptions} [options]
   * @returns {string | null} the blob URL the press went to, and null where the
   *   page offers no way to make one.
   */
  function download(doc, name, text, options = {}) {
    // Called through the object that carries them, so neither goes out
    // detached from it.
    const urls = globalThis.URL;
    const make = options.createObjectURL ?? ((blob) => urls.createObjectURL(blob));
    const drop = options.revokeObjectURL ?? ((url) => urls.revokeObjectURL(url));
    const BlobType = options.Blob ?? globalThis.Blob;
    if (typeof BlobType !== 'function') return null;
    // A blob URL holds the file in memory until it is released, and nothing
    // releases one the page never handed over, so it is made once the press
    // has somewhere to happen.
    const host = doc.body ?? doc.documentElement;
    if (host === null) return null;
    const url = make(new BlobType([text], { type: MIME }));
    const anchor = doc.createElement('a');
    anchor.setAttribute('href', url);
    anchor.setAttribute('download', name);
    anchor.setAttribute('hidden', '');
    host.append(anchor);
    /** @type {{ click?: () => void }} */ (/** @type {unknown} */ (anchor)).click?.();
    anchor.remove();
    setTimeout(() => drop(url), 0);
    return url;
  }

  const exported = {
    MIME,
    COLUMNS,
    field,
    toCsv,
    filenameFor,
    download,
  };

  globalThis.bghsa.csv = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
