const returnErrors = new Map([
  ['denied', 'GitHub authorization was denied.'],
  ['expired', 'The GitHub authorization request expired. Please try again.'],
  ['error', 'Something went wrong connecting to GitHub. Please try again.'],
  ['unavailable', 'GitHub connect is temporarily unavailable. Please try again later.'],
]);

export function consumeGithubConnectReturn(): string | null {
  const { search, pathname, hash } = window.location;
  const params = new URLSearchParams(search);
  const outcome = params.get('github');
  if (!outcome) return null;
  params.delete('github');
  const query = params.toString();
  window.history.replaceState(window.history.state, '', `${pathname}${query ? `?${query}` : ''}${hash}`);
  return returnErrors.get(outcome) ?? null;
}
