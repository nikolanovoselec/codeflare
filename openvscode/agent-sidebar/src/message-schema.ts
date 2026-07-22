import type { BackendKind } from './backend.ts';
import { notImplemented } from './not-implemented.ts';

export type AuthorizedWebviewMessage =
  | Readonly<{ type: 'prompt'; message: string }>
  | Readonly<{ type: 'abort' }>
  | Readonly<{ type: 'newConversation' }>
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
    void backend;
    void value;
    void this.#limits;
    return notImplemented('closed webview message authority');
  }
}
