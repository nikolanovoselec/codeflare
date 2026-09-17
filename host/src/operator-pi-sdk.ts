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
  extensions?: readonly unknown[];
  skills?: readonly unknown[];
  prompts?: readonly unknown[];
  themes?: readonly unknown[];
  agentsFiles?: readonly unknown[];
}

interface PiModelRuntime {
  getModel(provider: string, model: string): unknown;
}
interface PiAgentTool {
  name: string;
  prepareArguments?: (arguments_: unknown) => unknown;
  execute(toolCallId: string, arguments_: unknown, signal?: AbortSignal): Promise<unknown>;
}
interface PiAgentSession {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly isStreaming: boolean;
  readonly agent: { state: { tools: readonly PiAgentTool[] } };
  prompt(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
}
interface PiSdk {
  ModelRuntime: { create(options: object): Promise<PiModelRuntime> };
  SettingsManager: { inMemory(options: object): unknown };
  SessionManager: { create(cwd: string, sessionDir: string): unknown; open(file: string, sessionDir: string): unknown };
  createExtensionRuntime(): unknown;
  createAgentSession(options: object): Promise<{ session: PiAgentSession }>;
}

const DEFAULT_SDK_ROOT = '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent';

function validateProfile(profile: OperatorPiSdkProfile): void {
  const bounded = (value: string, max: number) => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= max;
  if (!bounded(profile.provider, 128) || !bounded(profile.model, 256) || !bounded(profile.thinkingLevel, 32)
    || !bounded(profile.systemPrompt, 64 * 1024) || profile.tools.length > 64
    || profile.tools.some(tool => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool))) {
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
    const result = await sdk.createAgentSession({ ...base, sessionManager });
    const session = result?.session;
    if (!session?.sessionId || !session.agent?.state || !Array.isArray(session.agent.state.tools)) {
      throw new Error('Provisioned Pi SDK returned no session');
    }
    return {
      get sessionId() { return session.sessionId; },
      get sessionFile() { return session.sessionFile; },
      get isStreaming() { return session.isStreaming; },
      prompt: text => session.prompt(text),
      async executeTool(input) {
        if (session.isStreaming) throw new Error('Pi conversation is busy');
        if (!options.profile.tools.includes(input.name)) throw new Error('Approved Pi tool is unavailable');
        const matches = session.agent.state.tools.filter(tool => tool.name === input.name);
        if (matches.length !== 1) throw new Error('Approved Pi tool is unavailable');
        input.signal.throwIfAborted();
        const tool = matches[0];
        const arguments_ = tool.prepareArguments ? tool.prepareArguments(structuredClone(input.arguments)) : input.arguments;
        await tool.execute(input.toolCallId, arguments_, input.signal);
        input.signal.throwIfAborted();
      },
      followUp: text => session.followUp(text),
      steer: text => session.steer(text),
      abort: () => session.abort(),
      subscribe: listener => session.subscribe(listener),
      dispose: () => session.dispose(),
    };
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
