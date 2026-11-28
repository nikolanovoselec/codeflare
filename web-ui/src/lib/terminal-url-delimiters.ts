/** Drop unmatched closing wrapper parentheses without rewriting URL content. */
export function trimTerminalUrlParentheses(url: string, precededByOpeningParenthesis = false): string {
  // Only prose with an opening wrapper can disambiguate punctuation after `)`.
  const candidate = precededByOpeningParenthesis ? url.replace(/(?<=\))[.,;:!?]+$/, '') : url;
  let depth = 0;
  let trailing = 0;
  for (const char of candidate) {
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
  return trailing > 0 ? candidate.slice(0, -trailing) : url;
}
