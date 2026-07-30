export const EXECUTION_PR_URL =
  'https://github.com/nikolanovoselec/codeflare-inference-mesh/pull/1';

/** Return the offset of the one owner-approved standalone URL, never URL input. */
export function approvedExecutionLinkStart(text: string, href: unknown): number | null {
  if (href !== EXECUTION_PR_URL) return null;
  const start = text.length - EXECUTION_PR_URL.length;
  if (start < 0 || text.slice(start) !== EXECUTION_PR_URL) return null;
  if (start > 0 && text[start - 1] !== '\n') return null;
  return text.indexOf(EXECUTION_PR_URL) === start ? start : null;
}
