export type HostTerminalMode = 'classic' | 'herdr';

export interface HostTerminalConfig {
  mode: HostTerminalMode;
  command: string;
  args: string;
}

export function resolveHostTerminalConfig(env: NodeJS.ProcessEnv): HostTerminalConfig {
  const mode: HostTerminalMode = env.CODEFLARE_TERMINAL_MODE === 'herdr' ? 'herdr' : 'classic';
  return {
    mode,
    command: env.TERMINAL_COMMAND ?? (mode === 'herdr' ? '/usr/local/bin/codeflare-herdr-terminal' : '/bin/bash'),
    args: env.TERMINAL_ARGS ?? (mode === 'herdr' ? '' : '-l'),
  };
}
