export function isBucketNameResponse(data: unknown): data is { bucketName: string | null } {
  if (typeof data !== 'object' || data === null || !('bucketName' in data)) {
    return false;
  }
  const bucketName = (data as Record<string, unknown>).bucketName;
  return typeof bucketName === 'string' || bucketName === null;
}
