// Import Root's real composition for its OAuth registration side effect. Do not
// register flows here: that would conceal a missing production bundle dependency.
import '../../../operators/dispatcher-sdk-storage';
import { createModels, type Credential, type CredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

/** Ordinary Wrangler bundle auth derivation only: no App, model turn or vendor I/O. */
export async function bundledDispatcherOAuth(): Promise<Response> {
  const saved: Credential = { type: 'oauth', access: 'synthetic-bundled-openai-access',
    refresh: 'synthetic-bundled-openai-refresh', expires: Date.now() + 3_600_000,
    clientId: 'synthetic-bundled-client', scopes: ['chatgpt.tokens.use.direct'] };
  const records = new Map<string, Credential>([['openai', saved]]);
  const credentials: CredentialStore = {
    read: async providerId => records.get(providerId),
    list: async () => [...records].map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: async () => { throw new Error('Unexpected fresh OAuth mutation'); },
    delete: async () => { throw new Error('Unexpected fresh OAuth deletion'); },
  };
  const models = createModels({ credentials,
    authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(openaiProvider());
  const resolved = await models.getAuth('openai');
  return Response.json({ apiKey: resolved?.auth.apiKey, source: resolved?.source });
}
