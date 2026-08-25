/**
 * The shared namespace every content script hangs its exports off. Content
 * scripts are classic scripts in one isolated world, so they reach each other
 * through this global.
 */
interface BghsaNamespace {
  allowlist: typeof import('../src/common/allowlist.js');
  content: typeof import('../src/content.js');
}

declare var bghsa: BghsaNamespace;
