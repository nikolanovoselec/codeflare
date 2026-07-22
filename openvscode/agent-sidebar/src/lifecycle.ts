import type {
  ActivationState,
  Backend,
  BackendFactories,
  BackendKind,
} from './backend.ts';
import { notImplemented } from './not-implemented.ts';

export function selectBackendKind(value: unknown): BackendKind {
  void value;
  return notImplemented('closed extension backend selection');
}

export class SidebarLifecycle {
  readonly #selected: BackendKind;
  readonly #factories: BackendFactories;

  constructor(selected: BackendKind, factories: BackendFactories) {
    this.#selected = selected;
    this.#factories = factories;
  }

  activate(): ActivationState {
    return { selected: this.#selected, running: false };
  }

  async resolveVisible(): Promise<Backend> {
    void this.#factories;
    return notImplemented('lazy visible sidebar backend resolution');
  }

  async newConversation(): Promise<Backend> {
    return notImplemented('backend replacement lifecycle');
  }

  async deactivate(): Promise<void> {
    return notImplemented('backend deactivation lifecycle');
  }
}
