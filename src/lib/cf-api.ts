import { z } from 'zod';
import { AppError } from './error-types';

const CfApiBaseSchema = z.object({
    success: z.boolean(),
    errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
    messages: z.array(z.unknown()).default([]),
});

type CfApiResponse<T = unknown> = z.infer<typeof CfApiBaseSchema> & { result?: T };

export async function parseCfResponse<T = unknown>(
    response: Response
): Promise<CfApiResponse<T>> {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        // Read body once and attempt JSON parse — Cloudflare sometimes omits
        // the content-type header on valid JSON responses, but HTML error pages
        // (502/504/captcha) will fail to parse.
        const text = await response.text().catch(() => '(empty body)');
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            throw new AppError(
                'CF_API_ERROR',
                response.status,
                `Cloudflare API returned non-JSON response (${contentType || 'no content-type'}): ${text.slice(0, 200)}`,
            );
        }
        const base = CfApiBaseSchema.parse(json);
        return { ...base, result: (json as Record<string, unknown>).result as T };
    }
    const json = await response.json();
    const base = CfApiBaseSchema.parse(json);
    return { ...base, result: (json as Record<string, unknown>).result as T };
}
