export type AgentSeedMode = 'default' | 'advanced';

export interface CompiledSeedDocument {
  key: string;
  contentType: string;
  content: string;
  modes: AgentSeedMode[];
}

export interface CompiledAgentSeed {
  documents: CompiledSeedDocument[];
  retiredKeys: string[];
  preseedHash: string;
  runtimeHash: string;
  source: string;
  counts: {
    claude: number;
    piNative: number;
    transformed: number;
  };
}

export interface CompileAgentSeedOptions {
  rootDir?: string;
}

export interface GenerateAgentSeedOptions extends CompileAgentSeedOptions {
  outputFile?: string;
  log?: (message: string) => void;
}

export function computeAgentRuntimeHash(rootDir?: string): Promise<string>;
export function compileAgentSeed(options?: CompileAgentSeedOptions): Promise<CompiledAgentSeed>;
export function generateAgentSeed(options?: GenerateAgentSeedOptions): Promise<CompiledAgentSeed>;
