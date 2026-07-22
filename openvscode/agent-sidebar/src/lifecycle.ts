import type {
  ActivationState,
  Backend,
  BackendFactories,
  BackendKind,
} from './backend.ts';

export function selectBackendKind(value: unknown): BackendKind {
  if (value === 'pi' || value === 'claude') return value;
  throw new Error('Unsupported sidebar backend');
}

export class SidebarLifecycle {
  readonly #selected: BackendKind;
  readonly #factories: BackendFactories;
  #backend: Backend | undefined;
  #starting: Promise<Backend> | undefined;

  constructor(selected: BackendKind, factories: BackendFactories) {
    this.#selected = selected;
    this.#factories = factories;
  }

  activate(): ActivationState {
    return { selected: this.#selected, running: false };
  }

  async resolveVisible(): Promise<Backend> {
    if (this.#backend) return this.#backend;
    if (this.#starting) return this.#starting;

    const factory = this.#factories[this.#selected];
    this.#starting = (async () => {
      const backend = factory();
      await backend.start();
      this.#backend = backend;
      return backend;
    })();

    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async newConversation(): Promise<Backend> {
    await this.#stopCurrent();
    return this.resolveVisible();
  }

  async deactivate(): Promise<void> {
    await this.#stopCurrent();
  }

  async #stopCurrent(): Promise<void> {
    const backend = this.#backend ?? (this.#starting ? await this.#starting : undefined);
    this.#starting = undefined;
    this.#backend = undefined;
    await backend?.stop();
  }
}
