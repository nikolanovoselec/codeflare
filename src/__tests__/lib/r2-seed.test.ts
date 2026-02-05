import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';

const { mockFetch, mockCreateR2Client, mockGetR2Url, testState } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return {
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string, key?: string) =>
      key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`
    ),
    testState: {
      generatedDocs: [
        {
          key: 'Readme.TXT',
          contentType: 'text/plain; charset=utf-8',
          content: 'hello',
        },
        {
          key: 'Guides/QuickStart.MD',
          contentType: 'text/markdown; charset=utf-8',
          content: '# quick start',
        },
      ],
    },
  };
});

vi.mock('../../lib/r2-client', () => ({
  createR2Client: mockCreateR2Client,
  getR2Url: mockGetR2Url,
}));

vi.mock('../../lib/tutorial-seed.generated', () => ({
  get SEEDED_DOCUMENTS() {
    return testState.generatedDocs;
  },
}));

import { seedGettingStartedDocs } from '../../lib/r2-seed';

describe('seedGettingStartedDocs', () => {
  const env = {
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    testState.generatedDocs = [
      {
        key: 'Readme.TXT',
        contentType: 'text/plain; charset=utf-8',
        content: 'hello',
      },
      {
        key: 'Guides/QuickStart.MD',
        contentType: 'text/markdown; charset=utf-8',
        content: '# quick start',
      },
    ];
  });

  it('seeds only missing docs when overwrite=false', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    const result = await seedGettingStartedDocs(
      env,
      'test-bucket',
      'https://test.r2.cloudflarestorage.com',
      { overwrite: false }
    );

    expect(result.written).toEqual(['Readme.TXT']);
    expect(result.skipped).toEqual(['Guides/QuickStart.MD']);

    const calls = mockFetch.mock.calls.map((call) => ({
      url: call[0] as string,
      method: (call[1] as { method: string } | undefined)?.method,
    }));

    expect(calls).toEqual([
      {
        url: 'https://test.r2.cloudflarestorage.com/test-bucket/Readme.TXT',
        method: 'HEAD',
      },
      {
        url: 'https://test.r2.cloudflarestorage.com/test-bucket/Readme.TXT',
        method: 'PUT',
      },
      {
        url: 'https://test.r2.cloudflarestorage.com/test-bucket/Guides/QuickStart.MD',
        method: 'HEAD',
      },
    ]);
  });

  it('overwrites all docs when overwrite=true', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    const result = await seedGettingStartedDocs(
      env,
      'test-bucket',
      'https://test.r2.cloudflarestorage.com',
      { overwrite: true }
    );

    expect(result.written).toEqual(['Readme.TXT', 'Guides/QuickStart.MD']);
    expect(result.skipped).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((mockFetch.mock.calls[0][1] as { method: string }).method).toBe('PUT');
    expect((mockFetch.mock.calls[1][1] as { method: string }).method).toBe('PUT');
  });
});
