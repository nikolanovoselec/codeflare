import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const INPUT_NEEDED = '\u001b]777;notify;Pi;Agent needs your input\u0007';
const READY_FOR_INPUT = '\u001b]777;notify;Pi;Ready for input\u0007';

export function isPiRpcMode(argv: readonly string[]): boolean {
  return argv.some((value, index) => value === '--mode' && argv[index + 1] === 'rpc');
}

function emit(sequence: string): void {
  process.stdout.write(sequence);
}

// The ask_user_question package's public notifier channel. Channel names in
// the rpiv:* namespace are immutable with append-only payloads, so this
// subscription survives the package's major releases, unlike a toolName match
// on tool_call (a 2.x rename would silently kill the attention signal). It
// also fires only when a questionnaire will actually open (post-validation).
const ASK_USER_PROMPT_EVENT = 'rpiv:ask-user:prompt';

export default function nativeNotifications(
  pi: ExtensionAPI,
  argv: readonly string[] = process.argv,
): void {
  // RPC stdout is strict JSONL. Native Chat uses Code OSS notifications instead.
  if (isPiRpcMode(argv)) return;

  let turnSignal: AbortSignal | undefined;
  let suppressCompletion = false;

  pi.on('agent_start', async (_event, ctx) => {
    turnSignal = ctx.signal;
    suppressCompletion = false;
  });

  // The payload (question/option text) is deliberately ignored: fixed inert
  // notification text only, never model-authored content.
  pi.events.on(ASK_USER_PROMPT_EVENT, () => emit(INPUT_NEEDED));

  pi.on('tool_result', async (event) => {
    if (event.toolName !== 'ask_user_question') return;
    const details = event.details as { cancelled?: boolean } | undefined;
    suppressCompletion = details?.cancelled === true;
  });

  pi.on('agent_settled', async () => {
    const suppressed = suppressCompletion || turnSignal?.aborted === true;
    turnSignal = undefined;
    suppressCompletion = false;
    if (!suppressed) emit(READY_FOR_INPUT);
  });
}
