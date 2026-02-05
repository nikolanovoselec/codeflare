import { z } from 'zod';

const CfApiBaseSchema = z.object({
    success: z.boolean(),
    errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
    messages: z.array(z.unknown()).default([]),
});

type CfApiResponse<T = unknown> = z.infer<typeof CfApiBaseSchema> & { result?: T };

export async function parseCfResponse<T = unknown>(
    response: Response
): Promise<CfApiResponse<T>> {
    const json = await response.json();
    const base = CfApiBaseSchema.parse(json);
    return { ...base, result: (json as Record<string, unknown>).result as T };
}
