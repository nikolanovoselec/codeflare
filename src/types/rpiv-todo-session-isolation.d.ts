declare module "@earendil-works/pi-ai" {
  export function StringEnum(values: readonly string[], options?: Record<string, unknown>): any;
}

declare module "typebox" {
  export const Type: any;
  export type Static<T> = any;
}
