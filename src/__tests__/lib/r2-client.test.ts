import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createR2Client,
  getR2Url,
  parseListObjectsXml,
  parseInitiateMultipartUploadXml,
} from '../../lib/r2-client';

// Mock aws4fetch
vi.mock('aws4fetch', () => ({
  AwsClient: vi.fn().mockImplementation((opts: Record<string, string>) => ({
    _options: opts,
  })),
}));

describe('createR2Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an AwsClient with correct R2 credentials', () => {
    const env = {
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
    } as any;

    const client = createR2Client(env);
    expect(client).toBeDefined();
    expect((client as any)._options).toEqual({
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      service: 's3',
      region: 'auto',
    });
  });

  it('passes through credentials from env as-is', () => {
    const env = {
      R2_ACCESS_KEY_ID: 'key-with-special-chars!@#',
      R2_SECRET_ACCESS_KEY: 'secret/with/slashes',
    } as any;

    const client = createR2Client(env);
    expect((client as any)._options.accessKeyId).toBe('key-with-special-chars!@#');
    expect((client as any)._options.secretAccessKey).toBe('secret/with/slashes');
  });
});

describe('getR2Url', () => {
  const endpoint = 'https://abc123.r2.cloudflarestorage.com';

  it('constructs URL with bucket only', () => {
    const url = getR2Url(endpoint, 'my-bucket');
    expect(url).toBe('https://abc123.r2.cloudflarestorage.com/my-bucket');
  });

  it('constructs URL with bucket and key', () => {
    const url = getR2Url(endpoint, 'my-bucket', 'path/to/file.txt');
    expect(url).toBe('https://abc123.r2.cloudflarestorage.com/my-bucket/path/to/file.txt');
  });

  it('constructs URL with empty key', () => {
    const url = getR2Url(endpoint, 'my-bucket', '');
    expect(url).toBe('https://abc123.r2.cloudflarestorage.com/my-bucket');
  });

  it('constructs URL with undefined key', () => {
    const url = getR2Url(endpoint, 'my-bucket', undefined);
    expect(url).toBe('https://abc123.r2.cloudflarestorage.com/my-bucket');
  });

  it('handles key with leading slash', () => {
    const url = getR2Url(endpoint, 'my-bucket', '/leading-slash.txt');
    expect(url).toBe('https://abc123.r2.cloudflarestorage.com/my-bucket/leading-slash.txt');
  });

  it('handles endpoint with trailing slash', () => {
    const url = getR2Url('https://abc123.r2.cloudflarestorage.com/', 'my-bucket', 'file.txt');
    expect(url).toBe('https://abc123.r2.cloudflarestorage.com/my-bucket/file.txt');
  });

  it('handles deeply nested key paths', () => {
    const url = getR2Url(endpoint, 'my-bucket', 'workspace/project-a/src/index.ts');
    expect(url).toBe('https://abc123.r2.cloudflarestorage.com/my-bucket/workspace/project-a/src/index.ts');
  });
});

describe('parseListObjectsXml', () => {
  it('parses a standard ListBucketResult with objects', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>workspace/file.ts</Key>
    <Size>1234</Size>
    <LastModified>2024-01-15T10:00:00.000Z</LastModified>
    <ETag>"abc123"</ETag>
  </Contents>
  <Contents>
    <Key>workspace/readme.md</Key>
    <Size>567</Size>
    <LastModified>2024-01-16T12:00:00.000Z</LastModified>
    <ETag>"def456"</ETag>
  </Contents>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.objects).toHaveLength(2);
    expect(result.objects[0]).toEqual({
      key: 'workspace/file.ts',
      size: 1234,
      lastModified: '2024-01-15T10:00:00.000Z',
      etag: '"abc123"',
    });
    expect(result.objects[1]).toEqual({
      key: 'workspace/readme.md',
      size: 567,
      lastModified: '2024-01-16T12:00:00.000Z',
      etag: '"def456"',
    });
    expect(result.isTruncated).toBe(false);
    expect(result.prefixes).toEqual([]);
    expect(result.nextContinuationToken).toBeUndefined();
  });

  it('parses truncated result with continuation token', () => {
    const xml = `<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token123abc</NextContinuationToken>
  <Contents>
    <Key>file1.txt</Key>
    <Size>100</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.isTruncated).toBe(true);
    expect(result.nextContinuationToken).toBe('token123abc');
    expect(result.objects).toHaveLength(1);
  });

  it('parses common prefixes (directory-like listings)', () => {
    const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <CommonPrefixes>
    <Prefix>workspace/project-a/</Prefix>
  </CommonPrefixes>
  <CommonPrefixes>
    <Prefix>workspace/project-b/</Prefix>
  </CommonPrefixes>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.prefixes).toEqual([
      'workspace/project-a/',
      'workspace/project-b/',
    ]);
    expect(result.objects).toEqual([]);
  });

  it('parses mixed objects and prefixes', () => {
    const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>workspace/CLAUDE.md</Key>
    <Size>2048</Size>
    <LastModified>2024-02-01T00:00:00.000Z</LastModified>
    <ETag>"etag1"</ETag>
  </Contents>
  <CommonPrefixes>
    <Prefix>workspace/src/</Prefix>
  </CommonPrefixes>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].key).toBe('workspace/CLAUDE.md');
    expect(result.prefixes).toEqual(['workspace/src/']);
  });

  it('handles empty result (no objects, no prefixes)', () => {
    const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.objects).toEqual([]);
    expect(result.prefixes).toEqual([]);
    expect(result.isTruncated).toBe(false);
    expect(result.nextContinuationToken).toBeUndefined();
  });

  it('handles objects without ETag', () => {
    const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>file-without-etag.txt</Key>
    <Size>0</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].etag).toBeUndefined();
  });

  it('handles zero-byte files', () => {
    const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>empty-file</Key>
    <Size>0</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.objects[0].size).toBe(0);
  });

  it('handles large file sizes', () => {
    const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>large-file.bin</Key>
    <Size>5368709120</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.objects[0].size).toBe(5368709120); // 5 GiB
  });

  it('defaults IsTruncated to false when missing', () => {
    const xml = `<ListBucketResult>
  <Contents>
    <Key>file.txt</Key>
    <Size>100</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.isTruncated).toBe(false);
  });

  it('handles special characters in keys', () => {
    const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>path/to/file with spaces.txt</Key>
    <Size>100</Size>
    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

    const result = parseListObjectsXml(xml);
    expect(result.objects[0].key).toBe('path/to/file with spaces.txt');
  });
});

describe('parseInitiateMultipartUploadXml', () => {
  it('extracts UploadId from standard response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult>
  <Bucket>my-bucket</Bucket>
  <Key>my-key</Key>
  <UploadId>upload-id-123</UploadId>
</InitiateMultipartUploadResult>`;

    const uploadId = parseInitiateMultipartUploadXml(xml);
    expect(uploadId).toBe('upload-id-123');
  });

  it('extracts UploadId with special characters', () => {
    const xml = `<InitiateMultipartUploadResult>
  <UploadId>abc123-def456_ghi.789</UploadId>
</InitiateMultipartUploadResult>`;

    const uploadId = parseInitiateMultipartUploadXml(xml);
    expect(uploadId).toBe('abc123-def456_ghi.789');
  });

  it('throws when UploadId is not found', () => {
    const xml = `<InitiateMultipartUploadResult>
  <Bucket>my-bucket</Bucket>
</InitiateMultipartUploadResult>`;

    expect(() => parseInitiateMultipartUploadXml(xml)).toThrow(/UploadId/i);
  });

  it('throws on completely malformed XML', () => {
    expect(() => parseInitiateMultipartUploadXml('not xml at all')).toThrow(/UploadId/i);
  });

  it('throws on empty string', () => {
    expect(() => parseInitiateMultipartUploadXml('')).toThrow(/UploadId/i);
  });
});

