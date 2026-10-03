// Run this function in the real browser on the rendered Operators catalog or detail view.
// Observation only: no requests, navigation, settings changes or synthetic UI elements.
function checkOperatorPillColors() {
  const canvas = document.createElement('canvas').getContext('2d');
  if (!canvas) throw new Error('Real browser color rendering is required');
  const normalize = value => {
    if (!value) throw new Error('Missing rendered theme color');
    canvas.fillStyle = '#010203';
    canvas.fillStyle = value;
    const first = canvas.fillStyle;
    canvas.fillStyle = '#040506';
    canvas.fillStyle = value;
    if (canvas.fillStyle !== first) throw new Error('Browser could not resolve the theme color');
    return first;
  };
  const inspect = (selector, token, kind) => Array.from(document.querySelectorAll(selector))
    .filter(element => element.getClientRects().length > 0)
    .map(element => {
      const style = getComputedStyle(element);
      const actual = normalize(style.color);
      const expected = normalize(style.getPropertyValue(token).trim());
      return { kind, actual, expected, matches: actual === expected };
    });
  const checks = [
    ...inspect('.operator-list .operator-type-pill', '--color-accent', 'catalog-pill'),
    ...inspect('.operator-overview .operator-type-pill', '--color-accent', 'detail-pill'),
    ...inspect('.operator-catalog-meta > span:not(.admin-status)', '--color-text-secondary', 'catalog-metadata'),
  ];
  if (!checks.length) throw new Error('No rendered Operator catalog or detail elements to check');
  return checks;
}
