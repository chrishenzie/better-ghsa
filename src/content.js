'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

/**
 * @typedef {object} AdvisoryLocation
 * @property {string} owner
 * @property {string} repo
 * @property {string | null} ghsaId The advisory, or null on the list page.
 */

/**
 * The advisory a github.com path points at.
 *
 * @param {string} pathname
 * @returns {AdvisoryLocation | null} null when the path is not an advisory page
 */
function locate(pathname) {
  const parts = pathname.split('/').filter((part) => part !== '');
  const [owner, repo, security, advisories, ghsaId] = parts;
  if (owner === undefined || repo === undefined) return null;
  if (security !== 'security' || advisories !== 'advisories') return null;
  return { owner, repo, ghsaId: ghsaId ?? null };
}

/** Log the advisory this page is, and whether writes to it are permitted. */
function report() {
  const here = locate(globalThis.location.pathname);
  if (here === null) return;
  const nameWithOwner = `${here.owner}/${here.repo}`;
  const subject = here.ghsaId === null ? 'advisory list' : here.ghsaId;
  const writes = globalThis.bghsa.allowlist.isAllowed(nameWithOwner)
    ? 'writes permitted'
    : 'writes refused';
  console.info(`[better-ghsa] ${nameWithOwner} ${subject}, ${writes}`);
}

globalThis.bghsa.content = { locate, report };

if (typeof module !== 'undefined') {
  module.exports = { locate, report };
} else {
  report();
}
