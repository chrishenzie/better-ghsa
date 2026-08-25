'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

/**
 * Repositories writes are permitted on, as `owner/repo`.
 *
 * Editing this list and reloading the extension is the only way to change it.
 *
 * @type {readonly string[]}
 */
const ALLOWLIST = ['containerd/containerd', 'git-utensils/Spoon-Knife'];

/**
 * Whether writes are permitted on a repository. The comparison is
 * case-insensitive, matching GitHub's treatment of owner and repository names.
 *
 * @param {string} nameWithOwner `owner/repo`
 * @returns {boolean}
 */
function isAllowed(nameWithOwner) {
  const wanted = String(nameWithOwner).toLowerCase();
  return ALLOWLIST.some((entry) => entry.toLowerCase() === wanted);
}

globalThis.bghsa.allowlist = { ALLOWLIST, isAllowed };

if (typeof module !== 'undefined') {
  module.exports = { ALLOWLIST, isAllowed };
}
