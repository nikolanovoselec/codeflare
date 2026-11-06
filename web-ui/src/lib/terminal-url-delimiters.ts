/** Drop unmatched closing wrapper parentheses without rewriting URL content. */
export function trimTerminalUrlParentheses(url: string): string {
  let depth = 0;
  let trailing = 0;
  for (const char of url) {
    if (char === '(') {
      depth++;
      trailing = 0;
    } else if (char === ')') {
      if (depth > 0) {
        depth--;
        trailing = 0;
      } else trailing++;
    } else trailing = 0;
  }
  return trailing > 0 ? url.slice(0, -trailing) : url;
}
