export interface ManagedReleaseLimits {
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly documentCount: number;
  readonly documentBytes: number;
  readonly totalDocumentBytes: number;
  readonly pathBytes: number;
  readonly retiredPathCount: number;
  readonly extensionCount: number;
  readonly extensionBytes: number;
  readonly aggregateExtensionBytes: number;
  readonly redirectCount: 1;
}

export const MANAGED_RELEASE_CONTENT_TYPES: readonly string[];
export const MANAGED_RELEASE_LIMITS: ManagedReleaseLimits;
