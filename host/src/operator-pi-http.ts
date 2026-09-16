/**
 * Narrow authenticated host API for the parent-owned Pi conversation.
 * The outer request router owns container authentication; this controller owns
 * only fixed methods/paths, bounded JSON and projection-safe responses.
 */
import type { OperatorPiConversation } from './operator-pi.js';

export interface OperatorPiHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class OperatorPiHttpController {
  constructor(_conversation: OperatorPiConversation) {}
  async handle(_input: { method: string; pathname: string; query?: URLSearchParams; body?: Uint8Array }): Promise<OperatorPiHttpResult | null> {
    throw new Error('Not implemented');
  }
}
