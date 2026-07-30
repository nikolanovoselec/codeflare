import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export function isPiRpcMode(argv: readonly string[]): boolean {
  return argv.some((value, index) => value === '--mode' && argv[index + 1] === 'rpc');
}

export default function nativeNotifications(pi: ExtensionAPI): void {
  // RPC stdout is strict JSONL. Native Chat uses Code OSS notifications instead.
  if (isPiRpcMode(process.argv)) return;
  pi.on('agent_settled', async () => {
    process.stdout.write('\u001b]777;notify;Pi;Ready for input\u0007');
  });
}
