/**
 * Production Pi SDK factory for an operator-owned conversation.
 *
 * The host owns module loading, model/settings selection and exact session-file
 * reopening. Approved resources are supplied by trusted startup composition;
 * this boundary never invokes candidate-driven DefaultResourceLoader discovery.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { OperatorPiFactory, OperatorPiSession } from './operator-pi.js';
import { createOperatorPiReviewTools, type OperatorPiReviewConfig, type ReviewToolSdk } from './operator-pi-review.js';
import { createIsolatedPiTools, type IsolatedPiInitialization } from './operator-pi-isolated.js';
import { runApprovedTasks } from './operator-pi-isolated-runner.js';

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
  execute(toolCallId: string, arguments_: unknown, signal?: AbortSignal,
    onUpdate?: (result: unknown) => void): Promise<unknown>;
}
interface PiAi {
  validateToolArguments(tool: PiAgentTool, toolCall: {
    type: 'toolCall'; id: string; name: string; arguments: unknown;
  }): unknown;
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
interface PiSdk extends ReviewToolSdk {
  ModelRuntime: { create(options: object): Promise<PiModelRuntime> };
  SettingsManager: { inMemory(options: object): unknown };
  SessionManager: { create(cwd: string, sessionDir: string): unknown;
    open(file: string, sessionDir: string, cwdOverride?: string): unknown };
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
  review?: OperatorPiReviewConfig;
  isolated?: { initialization: IsolatedPiInitialization; deadline: number; outputRoot?: string };
  sdkRoot?: string;
  importSdk?: () => Promise<Record<string, unknown>>;
  importPiAi?: () => Promise<Record<string, unknown>>;
}): OperatorPiFactory {
  validateProfile(options.profile);
  const cwd = path.resolve(options.cwd);
  const agentDir = path.resolve(options.agentDir);
  const sessionDir = path.resolve(options.sessionDir);
  const sdkRoot = path.resolve(options.sdkRoot ?? DEFAULT_SDK_ROOT);
  const loadSdk = options.importSdk ?? (async () => import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href));
  const loadPiAi = options.importPiAi ?? (async () => import(pathToFileURL(
    path.join(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
  ).href));
  const approvedTools = options.isolated ? ['run_approved_tasks']
    : options.review ? ['read', 'write'] : [...options.profile.tools];
  let contextPromise: Promise<{ sdk: PiSdk; piAi: PiAi; base: Record<string, unknown> }> | undefined;

  const context = (): Promise<{ sdk: PiSdk; piAi: PiAi; base: Record<string, unknown> }> => {
    contextPromise ??= (async () => {
      const [sdkValue, piAiValue] = await Promise.all([loadSdk(), loadPiAi()]);
      const sdk = sdkValue as unknown as PiSdk;
      const piAi = piAiValue as unknown as PiAi;
      if (!sdk?.ModelRuntime?.create || !sdk?.SettingsManager?.inMemory || !sdk?.SessionManager?.create
        || !sdk.SessionManager.open || !sdk.createExtensionRuntime || !sdk.createAgentSession
        || ((options.review || options.isolated) && (!sdk.createReadToolDefinition || !sdk.createWriteToolDefinition))
        || !piAi?.validateToolArguments) {
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
      const fixedReviewResources = options.review !== undefined || options.isolated !== undefined;
      const resourceLoader = {
        getExtensions: () => ({ extensions: fixedReviewResources ? [] : [...(options.profile.extensions ?? [])], errors: [], runtime }),
        getSkills: () => ({ skills: fixedReviewResources ? [] : [...(options.profile.skills ?? [])], diagnostics: [] }),
        getPrompts: () => ({ prompts: fixedReviewResources ? [] : [...(options.profile.prompts ?? [])], diagnostics: [] }),
        getThemes: () => ({ themes: fixedReviewResources ? [] : [...(options.profile.themes ?? [])], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: fixedReviewResources ? [] : [...(options.profile.agentsFiles ?? [])] }),
        getSystemPrompt: () => options.profile.systemPrompt,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
      };
      const reviewTools = options.review ? createOperatorPiReviewTools(sdk, cwd, options.review) : undefined;
      const isolatedTools = options.isolated
        ? createIsolatedPiTools(sdk, cwd, options.isolated.initialization) : undefined;
      const base = { cwd, agentDir, model, modelRuntime: provisionedRuntime, resourceLoader,
        tools: options.isolated ? ['read', 'write'] : approvedTools,
        thinkingLevel: options.profile.thinkingLevel,
        settingsManager: sdk.SettingsManager.inMemory({
          compaction: { enabled: false }, retry: { enabled: false },
        }) };
      return { sdk, piAi, base: {
        ...base,
        ...((reviewTools || isolatedTools) ? { customTools: [
          ...(reviewTools ?? []), ...(isolatedTools ?? []),
        ] } : {}),
      } };
    })();
    return contextPromise;
  };

  const createWith = async (sessionManager: unknown): Promise<OperatorPiSession> => {
    const { sdk, piAi, base } = await context();
    const result = await sdk.createAgentSession({ ...base, sessionManager });
    const session = result?.session;
    if (!session?.sessionId || !session.agent?.state || !Array.isArray(session.agent.state.tools)) {
      throw new Error('Provisioned Pi SDK returned no session');
    }
    return {
      get sessionId() { return session.sessionId; },
      get sessionFile() { return session.sessionFile; },
      get isStreaming() { return session.isStreaming; },
      prompt: text => options.isolated ? Promise.reject(Error('Isolated Pi requires approved tasks')) : session.prompt(text),
      async executeTool(input) {
        if (session.isStreaming) throw new Error('Pi conversation is busy');
        if (!approvedTools.includes(input.name)) throw new Error('Approved Pi tool is unavailable');
        input.signal.throwIfAborted();
        if (options.isolated) {
          // This is a parent-mediated structured request, not a tool offered
          // to the root model. Only children receive SDK filesystem tools.
          const supplied = input.arguments;
          const expected = createHash('sha256').update(JSON.stringify(options.isolated.initialization)).digest('hex');
          if (input.name !== 'run_approved_tasks' || !supplied || typeof supplied !== 'object'
            || Array.isArray(supplied) || Object.keys(supplied).length !== 1
            || supplied.initializationDigest !== expected) throw Error('Approved task binding denied');
          await runApprovedTasks({ sdk, base, cwd, sessionDir, taskId: input.toolCallId,
            outputRoot: options.isolated.outputRoot ?? '/home/user/Operators',
            initialization: options.isolated.initialization, deadline: options.isolated.deadline,
            signal: input.signal });
          input.signal.throwIfAborted();
          return;
        }
        const matches = session.agent.state.tools.filter(tool => tool.name === input.name);
        if (matches.length !== 1) throw new Error('Approved Pi tool is unavailable');
        const tool = matches[0];
        const toolCall: { type: 'toolCall'; id: string; name: string; arguments: unknown } = {
          type: 'toolCall', id: input.toolCallId, name: input.name,
          arguments: structuredClone(input.arguments),
        };
        if (tool.prepareArguments) toolCall.arguments = tool.prepareArguments(toolCall.arguments);
        const arguments_ = piAi.validateToolArguments(tool, toolCall);
        await tool.execute(input.toolCallId, arguments_, input.signal, undefined);
        input.signal.throwIfAborted();
      },
      followUp: text => options.isolated ? Promise.reject(Error('Isolated Pi requires approved tasks')) : session.followUp(text),
      steer: text => options.isolated ? Promise.reject(Error('Isolated Pi requires approved tasks')) : session.steer(text),
      abort: () => session.abort(),
      subscribe: listener => session.subscribe(listener),
      dispose: () => session.dispose(),
    };
  };

  return {
    async create() {
      const { sdk } = await context();
      if (options.isolated) {
        // Pi's create() defers writing a session file until an assistant message.
        // The isolated root never prompts; open an exclusive empty file so the
        // SDK writes its header before Host persists the root conversation ID.
        await mkdir(sessionDir, { recursive: true, mode: 0o700 });
        const file = path.join(sessionDir, 'approved-parent.jsonl');
        const handle = await open(file, 'wx', 0o600);
        await handle.close();
        return createWith(sdk.SessionManager.open(file, sessionDir, cwd));
      }
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
