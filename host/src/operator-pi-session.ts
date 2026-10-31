/** Explicit public service composition for native root and restricted child sessions. */
export async function createOperatorPiSdkSession<T>(sdk: {
  createAgentSession(options: object): Promise<T>;
  createAgentSessionServices?(options: object): Promise<Record<string, unknown>>;
  createAgentSessionFromServices?(options: object): Promise<T>;
}, options: Record<string, unknown>, native: boolean): Promise<T> {
  if (!native) return sdk.createAgentSession(options);
  if (!sdk.createAgentSessionServices || !sdk.createAgentSessionFromServices) throw new Error('Provisioned Pi SDK is incompatible');
  const services = await sdk.createAgentSessionServices({ ...options,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, systemPrompt: '', appendSystemPrompt: [] } });
  // Services are a public value. Replace the inert loader with the same approved
  // explicit resources, never candidate/project discovery, for every session.
  return sdk.createAgentSessionFromServices({ ...options,
    services: { ...services, resourceLoader: options.resourceLoader } });
}

/** Public runtime policy: services may request an offline refresh, but Operators
 * must not refresh catalogs/credentials or expose login/mutation operations. */
export function readOnlyPiRuntime<T extends object>(runtime: T, model: { provider: string; id: string; api: string }): T {
  return new Proxy(runtime, { get(target, key) {
    if (['stream', 'streamSimple', 'complete', 'completeSimple'].includes(String(key))) {
      return (candidate: { provider: string; id: string; api: string }, ...args: unknown[]) => {
        if (!candidate || candidate.provider !== model.provider || candidate.id !== model.id || candidate.api !== model.api) {
          throw new Error('Approved Pi model binding mismatch');
        }
        const dispatch = Reflect.get(target, key, target);
        if (typeof dispatch !== 'function') throw new Error('Provisioned Pi SDK is incompatible');
        return dispatch.call(target, model, ...args);
      };
    }
    if (key === 'refresh') return async () => ({ aborted: false, errors: new Map() });
    if (['login', 'logout', 'setRuntimeApiKey', 'removeRuntimeApiKey', 'registerProvider',
      'registerNativeProvider', 'unregisterProvider', 'registerVirtualModel', 'unregisterVirtualModel'].includes(String(key))) {
      return () => { throw new Error('Operator Pi runtime is read-only'); };
    }
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
