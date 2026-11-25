const returnErrors = new Map([
  ['denied', 'GitHub authorization was denied.'],
  ['expired', 'The GitHub authorization request expired. Please try again.'],
  ['error', 'Something went wrong connecting to GitHub. Please try again.'],
  ['unavailable', 'GitHub connect is temporarily unavailable. Please try again later.'],
]);

export function consumeGithubConnectReturn(): string | null {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get('github');
  if (!outcome) return null;
  url.searchParams.delete('github');
  window.history.replaceState(window.history.state, '', url);
  return returnErrors.get(outcome) ?? null;
}
