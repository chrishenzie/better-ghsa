/**
 * The shared namespace every content script hangs its exports off. Content
 * scripts are classic scripts in one isolated world, so they reach each other
 * through this global.
 */
interface BghsaNamespace {
  allowlist: typeof import('../src/common/allowlist.js');
  trust: typeof import('../src/common/trust.js');
  parseDetail: typeof import('../src/common/parse-detail.js');
  derive: typeof import('../src/common/derive.js');
  content: typeof import('../src/content.js');
}

declare var bghsa: BghsaNamespace;
