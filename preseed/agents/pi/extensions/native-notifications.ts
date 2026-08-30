import { spawn } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const INPUT_NEEDED = '\u001b]777;notify;Pi;Agent needs your input\u0007';

export function isPiRpcMode(argv: readonly string[]): boolean {
  return argv.some((value, index) => value === '--mode' && argv[index + 1] === 'rpc');
}

function emitInputNeeded(): void {
  if (process.env.HERDR_ENV === '1') {
    const child = spawn('/usr/local/bin/codeflare-agent-event', ['input-required'], {
      stdio: 'ignore',
    });
    child.unref();
    return;
  }
  process.stdout.write(INPUT_NEEDED);
}

// The ask_user_question package's public notifier channel. Channel names in
// the rpiv:* namespace are immutable with append-only payloads, so this
// subscription survives package releases and fires only after validation.
const ASK_USER_PROMPT_EVENT = 'rpiv:ask-user:prompt';

export default function nativeNotifications(
  pi: ExtensionAPI,
  argv: readonly string[] = process.argv,
): void {
  // RPC stdout is strict JSONL. Native Chat uses Code OSS notifications instead.
  if (isPiRpcMode(argv)) return;

  let emittedForRun = false;
  pi.on('agent_start', async () => {
    emittedForRun = false;
  });

  // Ignore model-authored question text. One foreground run emits at most one
  // fixed attention event; Herdr status owns completion notification timing.
  pi.events.on(ASK_USER_PROMPT_EVENT, () => {
    if (emittedForRun) return;
    emittedForRun = true;
    emitInputNeeded();
  });
}
