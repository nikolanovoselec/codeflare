import type { BackendKind } from './backend.ts';

export type AuthorizedWebviewMessage =
  | Readonly<{ type: 'prompt'; message: string }>
  | Readonly<{ type: 'abort' }>
  | Readonly<{ type: 'newConversation' }>
  | Readonly<{ type: 'pi.cycleModel' }>
  | Readonly<{ type: 'pi.cycleThinking' }>
  | Readonly<{ type: 'terminal.input'; data: string }>
  | Readonly<{ type: 'terminal.resize'; columns: number; rows: number }>;

export interface WebviewMessageLimits {
  readonly maxPromptBytes: number;
  readonly maxTerminalInputBytes: number;
}

export type WebviewMessageErrorCode =
  | 'FORBIDDEN_MESSAGE'
  | 'INVALID_MESSAGE'
  | 'MESSAGE_TOO_LARGE'
  | 'INVALID_RESIZE';

export class WebviewMessageError extends Error {
  readonly code: WebviewMessageErrorCode;

  constructor(code: WebviewMessageErrorCode) {
    super(`Webview message error: ${code}`);
    this.name = 'WebviewMessageError';
    this.code = code;
  }
}

export class WebviewMessageAuthority {
  readonly #limits: WebviewMessageLimits;

  constructor(limits: WebviewMessageLimits) {
    this.#limits = limits;
  }

  parse(backend: BackendKind, value: unknown): AuthorizedWebviewMessage {
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw new WebviewMessageError('INVALID_MESSAGE');
    }

    if (value.type === 'abort' || value.type === 'newConversation') {
      assertExactKeys(value, ['type']);
      return { type: value.type };
    }

    if (backend === 'pi' && (value.type === 'pi.cycleModel' || value.type === 'pi.cycleThinking')) {
      assertExactKeys(value, ['type']);
      return { type: value.type };
    }

    if (backend === 'pi' && value.type === 'prompt') {
      assertExactKeys(value, ['type', 'message']);
      if (typeof value.message !== 'string') throw new WebviewMessageError('INVALID_MESSAGE');
      assertByteLimit(value.message, this.#limits.maxPromptBytes);
      return { type: 'prompt', message: value.message };
    }

    if (backend === 'claude' && value.type === 'terminal.input') {
      assertExactKeys(value, ['type', 'data']);
      if (typeof value.data !== 'string') throw new WebviewMessageError('INVALID_MESSAGE');
      assertByteLimit(value.data, this.#limits.maxTerminalInputBytes);
      return { type: 'terminal.input', data: value.data };
    }

    if (backend === 'claude' && value.type === 'terminal.resize') {
      assertExactKeys(value, ['type', 'columns', 'rows']);
      if (!validTerminalDimension(value.columns) || !validTerminalDimension(value.rows)) {
        throw new WebviewMessageError('INVALID_RESIZE');
      }
      return { type: 'terminal.resize', columns: value.columns, rows: value.rows };
    }

    throw new WebviewMessageError('FORBIDDEN_MESSAGE');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new WebviewMessageError('FORBIDDEN_MESSAGE');
  }
}

function assertByteLimit(value: string, limit: number): void {
  if (Buffer.byteLength(value, 'utf8') > limit) {
    throw new WebviewMessageError('MESSAGE_TOO_LARGE');
  }
}

function validTerminalDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000;
}
