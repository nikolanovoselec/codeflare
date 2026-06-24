const DISABLED_BRIDGE_IDLE_MS = "0";

type RuntimeEnv = Record<string, string | undefined>;

export function contextModeBridgeEnv<T extends RuntimeEnv>(
  env: T,
): T & { CONTEXT_MODE_BRIDGE_IDLE_MS: string } {
  return { ...env, CONTEXT_MODE_BRIDGE_IDLE_MS: DISABLED_BRIDGE_IDLE_MS };
}

export default function () {
  process.env.CONTEXT_MODE_BRIDGE_IDLE_MS = DISABLED_BRIDGE_IDLE_MS;
}
