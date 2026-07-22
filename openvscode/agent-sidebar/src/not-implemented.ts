export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED' as const;

export class NotImplementedError extends Error {
  readonly code = NOT_IMPLEMENTED;
  readonly feature: string;

  constructor(feature: string) {
    super(`${NOT_IMPLEMENTED}: ${feature}`);
    this.name = 'NotImplementedError';
    this.feature = feature;
  }
}

export function notImplemented(feature: string): never {
  throw new NotImplementedError(feature);
}
