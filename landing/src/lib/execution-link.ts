export const EXECUTION_PR_URL =
  'https://github.com/nikolanovoselec/codeflare-inference-mesh/pull/1';

/** Only the owner-approved PR URL may become interactive terminal content. */
export function isApprovedExecutionHref(text: string, href: unknown): href is string {
  return href === EXECUTION_PR_URL && text.split('\n').includes(EXECUTION_PR_URL);
}
