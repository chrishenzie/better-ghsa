'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

// The manifest orders content scripts; under Node the dependencies are named here.
if (typeof require === 'function') {
  require('./trust.js');
  require('./schema.js');
}

/**
 * Reads a cached advisory back into the shape the parser produces.
 *
 * A cache entry holds what some version of this extension wrote, so every field
 * is checked and none is assumed. What is derived from a field is derived
 * again here rather than read back: the trust rule and the schema rules that
 * apply are this version's, not the ones in force when the entry was written.
 *
 * Both surfaces that work from cached reads go through this file: the list
 * table's rows and the done view's corpus.
 */

(() => {
  /**
   * @param {unknown} value
   * @returns {string | null} the string it holds, and null for anything else.
   */
  function text(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  /**
   * @param {unknown} value
   * @returns {string[]} the strings with content the value holds.
   */
  function strings(value) {
    if (!Array.isArray(value)) return [];
    /** @type {string[]} */
    const found = [];
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim() !== '') found.push(entry);
    }
    return found;
  }

  /**
   * One comment out of a cached record. The author's standing and the snapshot
   * are recomputed here rather than read: the record is what an older version of
   * this extension wrote, and the trust rule and the schema rules are this
   * version's.
   *
   * @param {unknown} value
   * @returns {import('./parse-detail.js').ParsedComment | null}
   */
  function commentFrom(value) {
    const schema = globalThis.bghsa.schema;
    if (!schema.isPlainObject(value)) return null;
    const author = text(value.author);
    const role = text(value.role);
    const held = schema.isPlainObject(value.stateComment) ? text(value.stateComment.raw) : null;
    return {
      id: text(value.id) ?? '',
      elementId: text(value.elementId) ?? '',
      author,
      role,
      roles: strings(value.roles),
      trusted: globalThis.bghsa.trust.isTrustedAuthor(author, role),
      at: text(value.at),
      text: text(value.text) ?? '',
      stateComment: held === null ? null : schema.readSnapshot(held),
    };
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-detail.js').TimelineEvent | null}
   */
  function eventFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    return {
      id: text(value.id),
      actor: text(value.actor),
      at: text(value.at),
      text: text(value.text) ?? '',
    };
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-detail.js').ForkPullRequest | null}
   */
  function pullFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    const number = value.number;
    return {
      number: typeof number === 'number' && Number.isFinite(number) ? number : null,
      url: text(value.url),
      title: text(value.title) ?? '',
      state: text(value.state),
      baseRef: text(value.baseRef),
      headRef: text(value.headRef),
      author: text(value.author),
      openedAt: text(value.openedAt),
      assignees: strings(value.assignees),
    };
  }

  /**
   * @param {unknown} value
   * @returns {import('./parse-detail.js').PrivateFork | null}
   */
  function forkFrom(value) {
    if (!globalThis.bghsa.schema.isPlainObject(value)) return null;
    if (!Array.isArray(value.pullRequests)) return null;
    /** @type {import('./parse-detail.js').ForkPullRequest[]} */
    const pullRequests = [];
    for (const entry of value.pullRequests) {
      const pull = pullFrom(entry);
      if (pull !== null) pullRequests.push(pull);
    }
    return {
      cloneUrl: text(value.cloneUrl),
      repository: text(value.repository),
      deleteUrl: text(value.deleteUrl),
      pullRequests,
    };
  }

  /**
   * The advisory a cache entry holds. The entry is data an older version of this
   * extension wrote, so every field is checked and none is assumed: a record
   * carrying no comment list and no timeline is not one this reader can derive
   * anything from, and it answers as absent.
   *
   * @param {unknown} record
   * @returns {import('./parse-detail.js').ParsedDetail | null}
   */
  function advisoryFrom(record) {
    const schema = globalThis.bghsa.schema;
    if (!schema.isPlainObject(record)) return null;
    if (!Array.isArray(record.comments) || !Array.isArray(record.timeline)) return null;

    /** @type {import('./parse-detail.js').ParsedComment[]} */
    const comments = [];
    for (const entry of record.comments) {
      const comment = commentFrom(entry);
      if (comment !== null) comments.push(comment);
    }
    /** @type {import('./parse-detail.js').TimelineEvent[]} */
    const timeline = [];
    for (const entry of record.timeline) {
      const event = eventFrom(entry);
      if (event !== null) timeline.push(event);
    }

    return {
      ref: null,
      viewer: null,
      ghsaId: text(record.ghsaId),
      state: text(record.state),
      severity: text(record.severity),
      severityLabel: text(record.severityLabel),
      reportedAt: text(record.reportedAt),
      reporter: text(record.reporter),
      title: text(record.title),
      description: text(record.description),
      severityField: text(record.severityField),
      severityFieldPresent: record.severityFieldPresent === true,
      cvssV3: text(record.cvssV3),
      cvssV3Present: record.cvssV3Present === true,
      cveId: text(record.cveId),
      cveSelection: text(record.cveSelection),
      descriptionOriginal:
        typeof record.descriptionOriginal === 'boolean' ? record.descriptionOriginal : null,
      descriptionRevision: null,
      comments,
      timeline,
      fork: forkFrom(record.fork),
      collaborators: strings(record.collaborators),
    };
  }

  const exported = { text, strings, commentFrom, eventFrom, pullFrom, forkFrom, advisoryFrom };

  globalThis.bghsa.record = exported;

  if (typeof module !== 'undefined') {
    module.exports = exported;
  }
})();
