import { Buffer } from 'node:buffer';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// AWS rest-json eventstream headers plus JSON event payload, including its CRCs.
export function bedrockEventFrame(eventType: string, payload: unknown, messageType = 'event'): Uint8Array {
  const encoder = new TextEncoder();
  const headers = Uint8Array.from(Object.entries({
    ':message-type': messageType,
    [messageType === 'exception' ? ':exception-type' : ':event-type']: eventType,
    ':content-type': 'application/json',
  }).flatMap(([name, value]) => {
    const key = encoder.encode(name); const text = encoder.encode(value);
    return [key.length, ...key, 7, text.length >>> 8, text.length & 255, ...text];
  }));
  const body = encoder.encode(JSON.stringify(payload));
  const total = 16 + headers.length + body.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  view.setUint32(8, crc32(bytes.subarray(0, 8)));
  bytes.set(headers, 12);
  bytes.set(body, 12 + headers.length);
  view.setUint32(total - 4, crc32(bytes.subarray(0, total - 4)));
  return bytes;
}

// InvokeModelWithResponseStream's PayloadPart carries base64 bytes, not a raw
// Anthropic event: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_PayloadPart.html
export function bedrockChunkFrame(event: unknown): Uint8Array {
  return bedrockEventFrame('chunk', { bytes: Buffer.from(JSON.stringify(event), 'utf8').toString('base64') });
}
