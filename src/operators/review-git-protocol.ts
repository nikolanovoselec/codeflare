/** Bounded byte-level receive-pack observation, never a packfile buffer or Git retry. */
export interface ConfirmedGitUpdate { ref: string; head: string }
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_METADATA = 64 * 1024;

type ParsedPackets = { lines: Uint8Array[]; end: number };
function packets(bytes: Uint8Array): ParsedPackets | null {
  const lines: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    let size = 0;
    for (let index = offset; index < offset + 4; index++) {
      const char = bytes[index];
      const digit = char >= 48 && char <= 57 ? char - 48
        : char >= 97 && char <= 102 ? char - 87
          : char >= 65 && char <= 70 ? char - 55 : -1;
      if (digit < 0) throw Error('Invalid Git packet');
      size = (size << 4) | digit;
    }
    if (size === 0) return { lines, end: offset + 4 };
    if (size < 4 || size > 65520) throw Error('Invalid Git packet size');
    if (offset + size > bytes.byteLength) return null;
    lines.push(bytes.subarray(offset + 4, offset + size));
    offset += size;
  }
  return null;
}
function join(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
function command(bytes: Uint8Array): { update: ConfirmedGitUpdate; sideband: boolean } | null {
  const parsed = packets(bytes);
  if (!parsed || parsed.lines.length !== 1) return null;
  const match = /^([a-fA-F0-9]{40}) ([a-fA-F0-9]{40}) (refs\/heads\/[A-Za-z0-9._/-]+)\0([^\n]*)\n$/.exec(decoder.decode(parsed.lines[0]));
  if (!match || match[1] === match[2] || /^0{40}$/.test(match[2])) return null;
  const capabilities = match[4].split(' ');
  if (!capabilities.some(cap => cap === 'report-status' || cap === 'report-status-v2')) return null;
  return { update: { ref: match[3], head: match[2] },
    sideband: capabilities.includes('side-band') || capabilities.includes('side-band-64k') };
}
function acknowledged(bytes: Uint8Array, requested: ConfirmedGitUpdate): boolean {
  const parsed = packets(bytes);
  if (!parsed || parsed.end !== bytes.byteLength || parsed.lines.length !== 2) return false;
  return decoder.decode(parsed.lines[0]) === 'unpack ok\n'
    && decoder.decode(parsed.lines[1]) === `ok ${requested.ref}\n`;
}
function reply(bytes: Uint8Array, expected: { update: ConfirmedGitUpdate; sideband: boolean }): boolean {
  const parsed = packets(bytes);
  if (!parsed || parsed.end !== bytes.byteLength) return false;
  if (!expected.sideband) return acknowledged(bytes, expected.update);
  const status: Uint8Array[] = [];
  for (const line of parsed.lines) {
    if (line[0] === 3 || (line[0] !== 1 && line[0] !== 2)) return false;
    if (line[0] === 1) status.push(line.subarray(1));
  }
  return acknowledged(join(status), expected.update);
}

export function createReviewPushObserver(): {
  wrapUpload(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
  wrapDownload(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
  result: Promise<ConfirmedGitUpdate | null>;
  abort(): void;
} {
  let upload: Uint8Array[] = [];
  let uploadSize = 0;
  let download: Uint8Array[] = [];
  let downloadSize = 0;
  let parsedUpload = false;
  let invalidUpload = false;
  let invalidReply = false;
  let commandValue: ReturnType<typeof command> = null;
  let uploadComplete = false;
  let responseComplete = false;
  let validResponse = false;
  let settle!: (value: ConfirmedGitUpdate | null) => void;
  const result = new Promise<ConfirmedGitUpdate | null>(resolve => { settle = resolve; });
  let settled = false;
  function finish(value: ConfirmedGitUpdate | null) {
    if (settled) return;
    settled = true;
    settle(value);
  }
  function reconcile() {
    if (uploadComplete && responseComplete) finish(!invalidUpload && !invalidReply && validResponse
      ? commandValue?.update ?? null : null);
  }
  function forward(source: ReadableStream<Uint8Array>, observe: (bytes: Uint8Array) => void,
    complete: (cancelled: boolean) => void): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { complete(false); controller.close(); return; }
          observe(next.value);
          controller.enqueue(next.value);
        } catch (error) { complete(true); controller.error(error); }
      },
      async cancel(reason) { complete(true); await reader.cancel(reason); },
    });
  }
  return {
    result,
    abort() { invalidUpload = true; invalidReply = true; finish(null); },
    wrapUpload(source) {
      return forward(source, bytes => {
        if (parsedUpload || invalidUpload) return;
        const take = Math.min(bytes.byteLength, MAX_METADATA - uploadSize);
        upload.push(bytes.slice(0, take));
        uploadSize += take;
        try {
          const all = join(upload);
          const parsed = packets(all);
          if (parsed) { commandValue = command(all.subarray(0, parsed.end)); parsedUpload = true; upload = []; }
          else if (take < bytes.byteLength || uploadSize >= MAX_METADATA) { invalidUpload = true; upload = []; }
        } catch { invalidUpload = true; upload = []; }
      }, cancelled => {
        uploadComplete = true;
        if (cancelled || !parsedUpload || !commandValue) invalidUpload = true;
        if (cancelled) finish(null);
        reconcile();
      });
    },
    wrapDownload(source) {
      return forward(source, bytes => {
        if (invalidReply) return;
        downloadSize += bytes.byteLength;
        if (downloadSize > MAX_METADATA) { invalidReply = true; download = []; finish(null); }
        else download.push(bytes.slice());
      }, cancelled => {
        responseComplete = true;
        if (cancelled) { finish(null); return; }
        try { validResponse = !!commandValue && !invalidReply && reply(join(download), commandValue); }
        catch { validResponse = false; }
        reconcile();
      });
    },
  };
}
