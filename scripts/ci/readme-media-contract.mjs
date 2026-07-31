export const README_MEDIA = Object.freeze([
  Object.freeze({ name: 'execution', source: '[data-readme-reel="execution"]', playback: 'once' }),
  Object.freeze({ name: 'browser-vscode', source: '#ide .terminal', playback: 'loop' }),
  Object.freeze({ name: 'browser-e2e', source: '#context .split-band:nth-of-type(2)', playback: 'once' }),
  Object.freeze({ name: 'review-governance', source: '#pipeline .review-board', playback: 'loop' }),
  Object.freeze({ name: 'deployment', source: '[data-execution-face="software"] .terminal', playback: 'once' }),
  Object.freeze({ name: 'inference-mesh', source: '#inference-mesh .mesh-hero-grid', playback: 'loop' }),
]);

export const RETIRED_README_PICTURES = Object.freeze([
  'mobile-foldable.jpg',
  'mobile-phone.jpg',
  'hero-ide-fullscreen.png',
  'guided-setup.png',
]);

export const README_MEDIA_BUDGETS = Object.freeze({
  gifBytes: 10 * 1024 * 1024,
  aggregateBytes: 30 * 1024 * 1024,
});
