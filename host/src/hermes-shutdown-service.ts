type Source = { owner: string; sessionId: string; generation: number; intent: string; snapshotId: string };
type Gateway = { model: string; reasoning?: string; contextWindow: number; reasoningLevels?: string[] };
type Result = { status: 'pending' | 'skipped' } | { status: 'merged'; receipt: { source: Source } };
const hex = /^[a-f0-9]{64}$/;
const route = /^[A-Za-z0-9._-]{1,128}$/;
const budget = 20 * 60_000;

/** Binds the private Host request to a successful save in this container. A
 * headless retry has the same already-confirmed snapshot in startup config. */
export function createHermesShutdownService(deps: {
  owner: string; sessionId: string; generation: number;
  retry?: { snapshotId: string };
  identifySavedSnapshot(signal: AbortSignal): Promise<string | null>;
  run(input: { source: Source; deadline: number; signal: AbortSignal;
    allowPersonalPiProviders: boolean; gateway?: Gateway }): Promise<Result>;
}) {
  let saved: string | null = deps.retry?.snapshotId ?? null;
  return {
    async saved(signal: AbortSignal) {
      signal.throwIfAborted();
      saved = null;
      const value = await deps.identifySavedSnapshot(signal);
      signal.throwIfAborted();
      saved = value && hex.test(value) ? value : null;
      return saved;
    },
    async merge(input: unknown, parent: AbortSignal): Promise<Result> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Hermes merge request');
      const { intent, snapshotId, deadline, allowPersonalPiProviders, gateway } = input as Record<string, unknown>;
      const now = Date.now();
      if (typeof intent !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(intent)
        || typeof snapshotId !== 'string' || !hex.test(snapshotId)
        || typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline <= now || deadline - now > budget
        || typeof allowPersonalPiProviders !== 'boolean') throw new Error('Invalid Hermes merge request');
      let configured: Gateway | undefined;
      if (gateway !== undefined) {
        const g = gateway as Partial<Gateway> | null;
        if (!g || typeof g.model !== 'string' || !route.test(g.model) || typeof g.contextWindow !== 'number'
          || !Number.isSafeInteger(g.contextWindow) || g.contextWindow <= 0
          || (g.reasoning !== undefined && (typeof g.reasoning !== 'string' || g.reasoning.length > 32))
          || (g.reasoningLevels !== undefined && (!Array.isArray(g.reasoningLevels) || g.reasoningLevels.length > 16
            || g.reasoningLevels.some(level => typeof level !== 'string' || level.length > 32)))) throw new Error('Invalid Hermes inference route');
        configured = { model: g.model, contextWindow: g.contextWindow, reasoning: g.reasoning, reasoningLevels: g.reasoningLevels };
      }
      const signal = AbortSignal.any([parent, AbortSignal.timeout(deadline - now)]);
      signal.throwIfAborted();
      if (snapshotId !== saved) throw new Error('No matching confirmed save');
      saved = null;
      const { owner, sessionId, generation } = deps;
      return deps.run({ source: { owner, sessionId, generation, intent, snapshotId }, deadline, signal,
        allowPersonalPiProviders, gateway: configured });
    },
  };
}
