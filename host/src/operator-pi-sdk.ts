/**
 * Production Pi SDK factory for an operator-owned conversation.
 *
 * The host owns module loading, model/settings selection and exact session-file
 * reopening. Approved resources are supplied by trusted startup composition;
 * this boundary never invokes candidate-driven DefaultResourceLoader discovery.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OperatorPiFactory, OperatorPiSession } from './operator-pi.js';

export interface OperatorPiSdkProfile {
  provider: string;
  model: string;
  thinkingLevel: string;
  systemPrompt: string;
  tools: readonly string[];
  /** Require a tool call on the first model turn; the named tool must be the sole approved tool. */
  initialToolChoice?: string;
  extensions?: readonly unknown[];
  skills?: readonly unknown[];
  prompts?: readonly unknown[];
  themes?: readonly unknown[];
  agentsFiles?: readonly unknown[];
}

interface PiModelRuntime {
  getModel(provider: string, model: string): unknown;
  streamSimple(model: unknown, context: unknown, options?: Record<string, unknown>): unknown;
}
interface PiSdk {
  ModelRuntime: { create(options: object): Promise<PiModelRuntime> };
  SettingsManager: { inMemory(options: object): unknown };
  SessionManager: { create(cwd: string, sessionDir: string): unknown; open(file: string, sessionDir: string): unknown };
  createExtensionRuntime(): unknown;
  createAgentSession(options: object): Promise<{ session: OperatorPiSession }>;
}

const DEFAULT_SDK_ROOT = '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent';

function validateProfile(profile: OperatorPiSdkProfile): void {
  const bounded = (value: string, max: number) => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= max;
  if (!bounded(profile.provider, 128) || !bounded(profile.model, 256) || !bounded(profile.thinkingLevel, 32)
    || !bounded(profile.systemPrompt, 64 * 1024) || profile.tools.length > 64
    || profile.tools.some(tool => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool))
    || (profile.initialToolChoice !== undefined
      && (profile.tools.length !== 1 || profile.tools[0] !== profile.initialToolChoice))) {
    throw new Error('Invalid approved Pi profile');
  }
}

/**
 * Resolve only the provisioned SDK and a caller-supplied trusted resource set.
 * The returned factory creates or opens one conversation under sessionDir; it
 * performs no resource discovery, model-network refresh or recent-session lookup.
 */
export function createProvisionedOperatorPiFactory(options: {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  profile: OperatorPiSdkProfile;
  sdkRoot?: string;
  importSdk?: () => Promise<Record<string, unknown>>;
}): OperatorPiFactory {
  validateProfile(options.profile);
  const cwd = path.resolve(options.cwd);
  const agentDir = path.resolve(options.agentDir);
  const sessionDir = path.resolve(options.sessionDir);
  const sdkRoot = path.resolve(options.sdkRoot ?? DEFAULT_SDK_ROOT);
  const loadSdk = options.importSdk ?? (async () => import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href));
  let contextPromise: Promise<{ sdk: PiSdk; base: Record<string, unknown> }> | undefined;

  const context = (): Promise<{ sdk: PiSdk; base: Record<string, unknown> }> => {
    contextPromise ??= (async () => {
      const sdk = await loadSdk() as unknown as PiSdk;
      if (!sdk?.ModelRuntime?.create || !sdk?.SettingsManager?.inMemory || !sdk?.SessionManager?.create
        || !sdk.SessionManager.open || !sdk.createExtensionRuntime || !sdk.createAgentSession) {
        throw new Error('Provisioned Pi SDK is incompatible');
      }
      const provisionedRuntime = await sdk.ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsPath: path.join(agentDir, 'models.json'),
        allowModelNetwork: false,
      });
      const model = provisionedRuntime.getModel(options.profile.provider, options.profile.model);
      if (!model) throw new Error('Approved model is unavailable in the provisioned Pi SDK');
      const runtime = sdk.createExtensionRuntime();
      const resourceLoader = {
        getExtensions: () => ({ extensions: [...(options.profile.extensions ?? [])], errors: [], runtime }),
        getSkills: () => ({ skills: [...(options.profile.skills ?? [])], diagnostics: [] }),
        getPrompts: () => ({ prompts: [...(options.profile.prompts ?? [])], diagnostics: [] }),
        getThemes: () => ({ themes: [...(options.profile.themes ?? [])], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [...(options.profile.agentsFiles ?? [])] }),
        getSystemPrompt: () => options.profile.systemPrompt,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
      };
      return { sdk, base: {
        cwd, agentDir, model, modelRuntime: provisionedRuntime, resourceLoader,
        tools: [...options.profile.tools], thinkingLevel: options.profile.thinkingLevel,
        settingsManager: sdk.SettingsManager.inMemory({
          compaction: { enabled: false }, retry: { enabled: false },
        }),
      } };
    })();
    return contextPromise;
  };

  const createWith = async (sessionManager: unknown): Promise<OperatorPiSession> => {
    const { sdk, base } = await context();
    const provisionedRuntime = base.modelRuntime as PiModelRuntime;
    let initialToolChoice: string | undefined;
    const modelRuntime = options.profile.initialToolChoice === undefined ? provisionedRuntime : new Proxy(provisionedRuntime, {
      get(target, property) {
        if (property === 'streamSimple') return (model: unknown, promptContext: unknown,
          streamOptions?: Record<string, unknown>) => {
          const required = initialToolChoice;
          initialToolChoice = undefined;
          return target.streamSimple(model, promptContext, required === undefined ? streamOptions : {
            ...streamOptions,
            toolChoice: { type: 'function', function: { name: required } },
          });
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await sdk.createAgentSession({ ...base, modelRuntime, sessionManager });
    if (!result?.session?.sessionId) throw new Error('Provisioned Pi SDK returned no session');
    const messages = (result.session as OperatorPiSession & { messages?: unknown }).messages;
    const hasModelTurn = Array.isArray(messages) && messages.some(message => Boolean(message)
      && typeof message === 'object' && !Array.isArray(message)
      && (message as { role?: unknown }).role === 'assistant');
    initialToolChoice = hasModelTurn ? undefined : options.profile.initialToolChoice;
    return result.session;
  };

  return {
    async create() {
      const { sdk } = await context();
      return createWith(sdk.SessionManager.create(cwd, sessionDir));
    },
    async open(sessionFile: string) {
      const resolved = path.resolve(sessionFile);
      if (sessionFile !== resolved || path.dirname(resolved) !== sessionDir || path.extname(resolved) !== '.jsonl') {
        throw new Error('Invalid owned session file');
      }
      const { sdk } = await context();
      return createWith(sdk.SessionManager.open(resolved, sessionDir));
    },
  };
}
