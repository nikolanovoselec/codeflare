/**
 * Production Pi SDK factory for an operator-owned conversation.
 *
 * The host owns module loading, model/settings selection and exact session-file
 * reopening. Approved resources are supplied by trusted startup composition;
 * this boundary never invokes candidate-driven DefaultResourceLoader discovery.
 */
import type { OperatorPiFactory } from './operator-pi.js';

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

export function createProvisionedOperatorPiFactory(_options: {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  profile: OperatorPiSdkProfile;
  sdkRoot?: string;
  importSdk?: () => Promise<Record<string, any>>;
}): OperatorPiFactory {
  throw new Error('Not implemented');
}
