export async function readBoundedStream(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  label: string,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel(`${label} exceeds ${limit} bytes`).catch(() => undefined);
        throw new Error(`${label} exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readBoundedResponse(
  response: Response,
  limit: number,
  label: string,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel(`${label} exceeds ${limit} bytes`).catch(() => undefined);
    throw new Error(`${label} exceeds ${limit} bytes`);
  }
  return readBoundedStream(response.body, limit, label);
}
