import type { KeyObject } from 'node:crypto';
import type { CompiledAgentSeed } from './agent-seed-core.mjs';

export type AgentSeedReleaseMode = 'default' | 'advanced';

export interface AgentSeedReleaseDocument {
  key: string;
  contentType: string;
  content: string;
  modes: AgentSeedReleaseMode[];
}

export interface ExtensionPackageManifest {
  publisher: string;
  name: string;
  version: string;
  engines: {
    vscode: string;
  };
  browser?: string;
  main?: string;
  extensionPack?: string[];
  extensionDependencies?: string[];
}

declare const measuredExtensionRecord: unique symbol;

export interface MeasuredExtensionRecord {
  readonly id: string;
  readonly publisher: string;
  readonly name: string;
  readonly version: string;
  readonly targetPlatform: string;
  readonly engine: string;
  readonly entrypoint: string;
  readonly extensionPack: readonly string[];
  readonly extensionDependencies: readonly string[];
  readonly downloadUrl: string;
  readonly size: number;
  readonly sha256: string;
  readonly [measuredExtensionRecord]: true;
}

export interface AgentSeedRelease {
  seedAbi: 1;
  sequence: number;
  source: {
    repositoryId: number;
    commitSha: string;
    releaseTag: string;
    compilerCommit: string;
  };
  runtimeDependencyHash: string;
  documents: AgentSeedReleaseDocument[];
  retiredPaths: string[];
  managedExtensions: MeasuredExtensionRecord[];
}

export interface MeasureExtensionRecordOptions {
  bytes: Uint8Array;
  manifest: ExtensionPackageManifest;
  platform: string;
  downloadUrl: string;
}

export interface BuildAgentSeedReleaseOptions {
  sourceRoot: string;
  sequence: number;
  previousSequence: number;
  repositoryId: number;
  sourceSha: string;
  compilerSha: string;
  releaseTag: string;
  managedExtensions?: readonly MeasuredExtensionRecord[];
  compile?: (options: { rootDir: string }) => Promise<CompiledAgentSeed>;
}

export interface ReleaseBundle {
  json: string;
  gzip: Buffer;
}

export const SEED_ABI: 1;

export function measureExtensionRecord(options: MeasureExtensionRecordOptions): MeasuredExtensionRecord;
export function buildAgentSeedRelease(options: BuildAgentSeedReleaseOptions): Promise<AgentSeedRelease>;
export function createReleaseBundle(release: AgentSeedRelease): ReleaseBundle;
export function signReleaseBundle(
  gzipBytes: Uint8Array,
  privateKey: KeyObject | string | Buffer,
): Buffer;
export function verifyReleaseBundle(
  gzipBytes: Uint8Array,
  signature: Uint8Array,
  publicKey: KeyObject | string | Buffer,
): boolean;
