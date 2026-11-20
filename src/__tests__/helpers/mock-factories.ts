/**
 * Shared mock factories for backend tests.
 *
 * Provides factory functions that return fully valid default objects with
 * optional partial overrides. Using spread merging keeps tests concise
 * while remaining explicit about what each test cares about.
 */

// ── Mock R2 Config ────────────────────────────────────────────────────────────

/**
 * Create the default mock return value for getR2Config().
 */
export function createMockR2Config(overrides?: {
  accountId?: string;
  endpoint?: string;
}) {
  return {
    accountId: overrides?.accountId ?? 'test-account',
    endpoint:
      overrides?.endpoint ?? 'https://test.r2.cloudflarestorage.com',
  };
}

/** Route-composition fixture: real task body, with DO admission tested at the Container boundary. */
export function createMockSetupNamespace(env: import('../../types').Env): import('../../types').Env['CONTAINER'] {
  const prior = env.CONTAINER;
  return new Proxy(prior ?? {} as typeof prior, {
    get(target, property) {
      if (property !== 'getByName') return Reflect.get(target, property);
      return (name: string) => name === 'setup:configuration' ? {
        async configureDeployment(input: import('../../routes/setup/index').SetupConfigurationInput) {
          const { runSetupConfiguration } = await import('../../routes/setup/index');
          return runSetupConfiguration({ ...input, env }, { waitUntil: task => { void task.catch(() => {}); }, settled: async () => {} });
        },
      } : target.getByName ? target.getByName(name) : target.get(target.idFromName(name));
    },
  });
}
