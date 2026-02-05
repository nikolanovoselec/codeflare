import { describe, it, expect } from 'vitest';
import { parseCfResponse } from '../../lib/cf-api';

describe('parseCfResponse', () => {
  it('parses a success response with result', async () => {
    const body = {
      success: true,
      errors: [],
      messages: [],
      result: { id: 'abc123', name: 'test-bucket' },
    };
    const response = new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });

    const parsed = await parseCfResponse<{ id: string; name: string }>(response);

    expect(parsed.success).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.messages).toEqual([]);
    expect(parsed.result).toEqual({ id: 'abc123', name: 'test-bucket' });
  });

  it('parses a failure response with errors array', async () => {
    const body = {
      success: false,
      errors: [
        { code: 10000, message: 'Authentication error' },
        { code: 10001, message: 'Invalid token' },
      ],
      messages: [],
    };
    const response = new Response(JSON.stringify(body));

    const parsed = await parseCfResponse(response);

    expect(parsed.success).toBe(false);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0].code).toBe(10000);
    expect(parsed.errors[0].message).toBe('Authentication error');
    expect(parsed.errors[1].code).toBe(10001);
  });

  it('handles missing optional fields with defaults', async () => {
    const body = {
      success: true,
    };
    const response = new Response(JSON.stringify(body));

    const parsed = await parseCfResponse(response);

    expect(parsed.success).toBe(true);
    // Zod defaults kick in for missing arrays
    expect(parsed.errors).toEqual([]);
    expect(parsed.messages).toEqual([]);
    expect(parsed.result).toBeUndefined();
  });

  it('handles response with result but no messages', async () => {
    const body = {
      success: true,
      errors: [],
      result: { id: 'zone-1' },
    };
    const response = new Response(JSON.stringify(body));

    const parsed = await parseCfResponse<{ id: string }>(response);

    expect(parsed.success).toBe(true);
    expect(parsed.messages).toEqual([]);
    expect(parsed.result).toEqual({ id: 'zone-1' });
  });

  it('throws on invalid JSON', async () => {
    const response = new Response('not valid json');

    await expect(parseCfResponse(response)).rejects.toThrow();
  });

  it('throws on non-object response (number)', async () => {
    const response = new Response('42');

    await expect(parseCfResponse(response)).rejects.toThrow();
  });

  it('throws on non-object response (string)', async () => {
    const response = new Response('"just a string"');

    await expect(parseCfResponse(response)).rejects.toThrow();
  });

  it('throws when success field is missing', async () => {
    const response = new Response(JSON.stringify({ errors: [] }));

    await expect(parseCfResponse(response)).rejects.toThrow();
  });

  it('throws when errors array has wrong shape', async () => {
    const body = {
      success: true,
      errors: [{ wrong: 'shape' }],
    };
    const response = new Response(JSON.stringify(body));

    await expect(parseCfResponse(response)).rejects.toThrow();
  });
});
