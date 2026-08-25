import { registerInitialToolFilter } from "./capability";

export function finalizeToolExposure(...args: Parameters<typeof registerInitialToolFilter>): void {
  registerInitialToolFilter(...args);
}

export default finalizeToolExposure;
