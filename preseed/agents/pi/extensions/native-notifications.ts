import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const INPUT_NEEDED = '\u001b]777;notify;Pi;Agent needs your input\u0007';
const READY_FOR_INPUT = '\u001b]777;notify;Pi;Ready for input\u0007';
const TASK_FAILED = '\u001b]777;notify;Pi;Task failed\u0007';

type RunState = {
  readonly started: boolean;
  readonly interactiveInput: boolean;
  readonly suppressed: boolean;
  readonly eventEmitted: boolean;
  readonly signal?: AbortSignal;
  readonly finalStopReason?: string;
};

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

  let run: RunState | undefined;

  pi.on('input', async (event) => {
    const interactiveInput = event.source === 'interactive';
    run = run === undefined
      ? {
          started: false,
          interactiveInput,
          suppressed: !interactiveInput,
          eventEmitted: false,
        }
      : {
          ...run,
          interactiveInput: run.interactiveInput || interactiveInput,
          suppressed: run.suppressed || !interactiveInput,
        };
  });

  pi.on('agent_start', async (_event, ctx) => {
    run = run === undefined
      ? {
          started: true,
          interactiveInput: false,
          suppressed: false,
          eventEmitted: false,
          signal: ctx.signal,
        }
      : {
          ...run,
          started: true,
          signal: ctx.signal,
          finalStopReason: undefined,
        };
  });

  // The payload (question/option text) is deliberately ignored: fixed inert
  // notification text only, never model-authored content. A run can produce at
  // most one terminal event, even if the notifier channel fires repeatedly.
  pi.events.on(ASK_USER_PROMPT_EVENT, () => {
    if (run?.eventEmitted === true) return;
    emit(INPUT_NEEDED);
    run = run === undefined
      ? {
          started: false,
          interactiveInput: false,
          suppressed: false,
          eventEmitted: true,
        }
      : { ...run, eventEmitted: true };
  });

  pi.on('tool_result', async (event) => {
    if (event.toolName !== 'ask_user_question') return;
    const details = event.details as { cancelled?: boolean } | undefined;
    if (details?.cancelled === true && run !== undefined) {
      run = { ...run, suppressed: true };
    }
  });

  pi.on('agent_end', async (event) => {
    if (run === undefined) return;
    const finalAssistant = [...event.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    run = { ...run, finalStopReason: finalAssistant?.stopReason };
  });

  pi.on('agent_settled', async () => {
    const settledRun = run;
    run = undefined;
    if (
      settledRun === undefined
      || !settledRun.started
      || !settledRun.interactiveInput
      || settledRun.suppressed
      || settledRun.eventEmitted
      || settledRun.signal?.aborted === true
      || settledRun.finalStopReason === undefined
      || settledRun.finalStopReason === 'aborted'
    ) return;

    emit(settledRun.finalStopReason === 'error' ? TASK_FAILED : READY_FOR_INPUT);
  });
}
