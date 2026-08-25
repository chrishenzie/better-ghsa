'use strict';

globalThis.bghsa ??= /** @type {BghsaNamespace} */ ({});

/**
 * The author role badges GitHub renders on an advisory comment, most
 * privileged first. A comment carries every badge that applies, so this order
 * is also the precedence used to name one role per comment.
 *
 * @type {readonly string[]}
 */
const ROLES = ['Owner', 'Member', 'Contributor', 'Author'];

/**
 * The roles whose snapshots count toward advisory state.
 *
 * @type {readonly string[]}
 */
const TRUSTED_ROLES = ['Owner', 'Member'];

/**
 * Whether snapshots written by a comment's author count toward advisory state.
 * The merge, the panel's warning, and the per-comment role labels all decide
 * through this function.
 *
 * A login is required because a snapshot with no identifiable author carries
 * no claim, and the role is the badge GitHub rendered on the comment.
 *
 * @param {string | null | undefined} login
 * @param {string | null | undefined} role One of {@link ROLES}, or any other
 *   badge text GitHub renders.
 * @returns {boolean}
 */
function isTrustedAuthor(login, role) {
  if (typeof login !== 'string' || login.trim() === '') return false;
  if (typeof role !== 'string') return false;
  const wanted = role.trim().toLowerCase();
  return TRUSTED_ROLES.some((trusted) => trusted.toLowerCase() === wanted);
}

globalThis.bghsa.trust = { ROLES, TRUSTED_ROLES, isTrustedAuthor };

if (typeof module !== 'undefined') {
  module.exports = { ROLES, TRUSTED_ROLES, isTrustedAuthor };
}
