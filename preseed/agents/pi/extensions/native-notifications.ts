import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const INPUT_NEEDED = '\u001b]777;notify;Pi;Agent needs your input\u0007';
const READY_FOR_INPUT = '\u001b]777;notify;Pi;Ready for input\u0007';

export function isPiRpcMode(argv: readonly string[]): boolean {
  return argv.some((value, index) => value === '--mode' && argv[index + 1] === 'rpc');
}

function emit(sequence: string): void {
  process.stdout.write(sequence);
}

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

  pi.on('tool_call', async (event) => {
    if (event.toolName === 'ask_user_question') emit(INPUT_NEEDED);
  });

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
