export type BackendKind = 'pi' | 'claude';

export interface Backend {
  readonly kind: BackendKind;
  readonly running: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BackendFactories {
  readonly pi: () => Backend;
  readonly claude: () => Backend;
}

export interface ActivationState {
  readonly selected: BackendKind;
  readonly running: false;
}
