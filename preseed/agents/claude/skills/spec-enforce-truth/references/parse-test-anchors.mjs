const TEST_ANCHOR_PATTERN = /<!--\s*@test:\s*(\S+?)\s*\((.*?)\)\s*-->/g;

export function parseTestAnchors(acText) {
  if (typeof acText !== 'string') return [];

  return [...acText.matchAll(TEST_ANCHOR_PATTERN)]
    .map((match) => ({
      path: match[1].trim(),
      blockTitle: match[2].trim(),
    }))
    .filter((anchor) => anchor.path.length > 0 && anchor.blockTitle.length > 0);
}
