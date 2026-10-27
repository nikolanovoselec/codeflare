/** External provider fixture, discovered by real createAgentSessionServices.
 * Genuine SDK context; no ModelRuntime replacement, global fetch override or SDK patch.
 */
import { readFile } from 'node:fs/promises';
import { channel } from 'node:diagnostics_channel';

export default async function register(pi) {
  const config = JSON.parse(await readFile(new URL('./operator-inference-config.json', import.meta.url), 'utf8'));
  const { createAssistantMessageEventStream } = await import(config.aiEntry);
  const lifecycle = config.lifecycleChannel ? channel(config.lifecycleChannel) : undefined;
  // Registration deliberately completes asynchronously, as configured user extensions may.
  await new Promise(resolve => setTimeout(resolve, 1));
  if (config.initializationFailure) throw new Error(`Provider initialization failed ${config.privateMarker}`);

  const cost = { input: 2, output: 7, cacheRead: 0.25, cacheWrite: 1 };
  const models = ['saved-model', 'second-model'].map(id => ({
    id, provider: config.provider, name: `Configured ${id}`, api: 'fixture-inference-v1',
    baseUrl: config.endpoint, reasoning: true, input: ['text', 'image'],
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium' },
    cost, contextWindow: 48000, maxTokens: 2048,
    headers: { 'x-fixture-model': 'configured-metadata' },
  }));

  const streamSimple = (model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 11, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 19,
        cost: { input: 0.000022, output: 0.000035, cacheRead: 0.0000005, cacheWrite: 0.000001, total: 0.0000585 } },
    };
    void (async () => {
      try {
        let payload = { model, context, options: { reasoning: options.reasoning, maxTokens: options.maxTokens },
          scopedEnv: options.env?.FIXTURE_SCOPE };
        payload = await options.onPayload?.(payload, model) ?? payload;
        const response = await fetch(`${model.baseUrl}/infer`, {
          method: 'POST', ...(config.ignoreAbort ? {} : { signal: options.signal }),
          headers: { ...model.headers, ...options.headers, 'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(payload),
        });
        await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
        const body = await response.json();
        if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${body.error}`);
        await options.onProviderStreamEvent?.({ type: 'fixture-response', text: body.text }, model);
        stream.push({ type: 'start', partial: message });
        message.content.push({ type: 'thinking', thinking: '', thinkingSignature: 'fixture-thinking-signature' });
        stream.push({ type: 'thinking_start', contentIndex: 0, partial: message });
        message.content[0].thinking = 'provider-owned reasoning';
        stream.push({ type: 'thinking_delta', contentIndex: 0, delta: message.content[0].thinking, partial: message });
        stream.push({ type: 'thinking_end', contentIndex: 0, content: message.content[0].thinking, partial: message });
        message.content.push({ type: 'text', text: '' });
        stream.push({ type: 'text_start', contentIndex: 1, partial: message });
        message.content[1].text = body.text;
        stream.push({ type: 'text_delta', contentIndex: 1, delta: body.text, partial: message });
        stream.push({ type: 'text_end', contentIndex: 1, content: body.text, partial: message });
        if (body.toolCall) {
          const toolCall = { type: 'toolCall', id: 'call-new', name: 'inspect', arguments: {} };
          message.content.push({ ...toolCall, arguments: {} });
          stream.push({ type: 'toolcall_start', contentIndex: 2, partial: message });
          message.content[2].arguments = { path: 'release.json' };
          stream.push({ type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"release.json"}', partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 2, toolCall: message.content[2], partial: message });
          message.stopReason = 'toolUse';
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
      } catch (error) {
        message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        message.errorMessage = error.message;
        stream.push({ type: 'error', reason: message.stopReason, error: message });
        stream.end();
      } finally { lifecycle?.publish({ type: 'settled' }); }
    })();
    return stream;
  };

  if (config.kind === 'legacy') {
    pi.registerProvider(config.provider, {
      name: 'Configured legacy provider', api: 'fixture-inference-v1', baseUrl: config.endpoint,
      apiKey: config.command, models, streamSimple,
    });
  } else {
    pi.registerProvider({
      id: config.provider, name: 'Configured native provider', baseUrl: config.endpoint,
      auth: {
        apiKey: {
          name: 'Fixture stored key',
          async check({ credential }) { return credential?.key ? { type: 'api_key', source: 'fixture' } : undefined; },
          async resolve({ credential }) {
            return credential?.key ? { auth: { apiKey: credential.key }, env: credential.env } : undefined;
          },
        },
        oauth: {
          name: 'Fixture OAuth',
          async login() { throw new Error('Interactive login is not part of this fixture'); },
          async refresh(credential, signal) {
            const response = await fetch(`${config.endpoint}/oauth`, {
              method: 'POST', signal, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ refresh: credential.refresh }),
            });
            if (!response.ok) throw new Error(`OAuth refresh failed ${config.privateMarker}`);
            return { type: 'oauth', ...await response.json() };
          },
          async toAuth(credential) { return { apiKey: credential.access }; },
        },
      },
      getModels() { return models; },
      stream: streamSimple, streamSimple,
    });
  }

  if (config.virtual) {
    pi.registerVirtualModel({
      provider: 'fixture-router', id: 'automatic', name: 'Configured automatic',
      thinkingLevels: ['low', 'medium'], contextWindow: 48000, maxTokens: 2048,
      route(request, ctx) {
        if (ctx.sessionManager.getSessionFile() !== undefined) throw new Error('Routing requires nonpersistent SDK context');
        lifecycle?.publish({ type: 'context', context: ctx });
        const second = request.messages.some(message => message.role === 'user'
          && typeof message.content === 'string' && message.content.includes('second physical'));
        return { model: ctx.modelRegistry.find(config.provider, second ? 'second-model' : 'saved-model'),
          thinkingLevel: request.thinkingLevel };
      },
    });
  }
}
