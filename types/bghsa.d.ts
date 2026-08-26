/**
 * The shared namespace every content script hangs its exports off. Content
 * scripts are classic scripts in one isolated world, so they reach each other
 * through this global.
 */
interface BghsaNamespace {
  dom: typeof import('../src/common/dom.js');
  text: typeof import('../src/common/text.js');
  allowlist: typeof import('../src/common/allowlist.js');
  trust: typeof import('../src/common/trust.js');
  schema: typeof import('../src/common/schema.js');
  merge: typeof import('../src/common/merge.js');
  parseDetail: typeof import('../src/common/parse-detail.js');
  derive: typeof import('../src/common/derive.js');
  members: typeof import('../src/common/members.js');
  write: typeof import('../src/common/write.js');
  tracking: typeof import('../src/detail/tracking.js');
  comments: typeof import('../src/detail/comments.js');
  preserve: typeof import('../src/detail/preserve.js');
  state: typeof import('../src/detail/state.js');
  edit: typeof import('../src/detail/edit.js');
  panel: typeof import('../src/detail/panel.js');
  content: typeof import('../src/content.js');
}

declare var bghsa: BghsaNamespace;
