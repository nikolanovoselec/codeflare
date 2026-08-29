import net from 'node:net';

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 1_000;

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseAboveBottom(line: string): boolean | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const result = value.result as Record<string, unknown> | undefined;
    const pane = result?.pane as Record<string, unknown> | undefined;
    const scroll = pane?.scroll as Record<string, unknown> | undefined;
    const offset = scroll?.offset_from_bottom;
    if (result?.type !== 'pane_current'
        || typeof pane?.pane_id !== 'string'
        || !isUint(offset)
        || !isUint(scroll?.max_offset_from_bottom)
        || !isUint(scroll?.viewport_rows)) {
      return null;
    }
    return offset > 0;
  } catch {
    return null;
  }
}

/** One bounded public-API query; null means fail open. */
export function queryHerdrScroll(
  socketPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        id: 'codeflare-scroll', method: 'pane.current', params: {},
      })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_RESPONSE_BYTES) return finish(null);
      const newline = response.indexOf(0x0a);
      if (newline !== -1) finish(parseAboveBottom(response.subarray(0, newline).toString('utf8')));
    });
    socket.once('error', () => finish(null));
    socket.once('end', () => {
      if (!response.includes(0x0a)) finish(null);
    });
  });
}
