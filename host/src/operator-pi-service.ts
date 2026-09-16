/**
 * Trusted startup composition for the host's operator Pi service.
 * Configuration comes only from parent-set process environment before the
 * restricted session starts; candidate requests cannot choose identities,
 * directories, model, tools or resources.
 */
import type { OperatorPiMetadata, OperatorPiStore } from './operator-pi.js';
import type { OperatorPiHttpController } from './operator-pi-http.js';

export class FileOperatorPiStore implements OperatorPiStore {
  constructor(_file: string) {}
  async load(): Promise<OperatorPiMetadata | null> { throw new Error('Not implemented'); }
  async save(_metadata: OperatorPiMetadata): Promise<void> { throw new Error('Not implemented'); }
}

export function createOperatorPiService(_options: {
  serializedConfig?: string;
  allowedRoot: string;
  importSdk?: () => Promise<Record<string, unknown>>;
}): OperatorPiHttpController | undefined {
  throw new Error('Not implemented');
}
