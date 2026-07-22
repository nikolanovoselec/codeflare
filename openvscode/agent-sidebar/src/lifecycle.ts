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

export async function resolveVisibleSafely(
  lifecycle: SidebarLifecycle,
  onFailure: (error: unknown) => void,
): Promise<Backend | undefined> {
  try {
    return await lifecycle.resolveVisible();
  } catch (error) {
    onFailure(error);
    return undefined;
  }
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
    if (this.#backend?.running) return this.#backend;
    if (this.#starting) return this.#starting;

    const backend = this.#backend ?? this.#factories[this.#selected]();
    this.#starting = (async () => {
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
