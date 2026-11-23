import { registerInitialToolFilter } from "./capability-helpers";

export function finalizeToolExposure(...args: Parameters<typeof registerInitialToolFilter>): void {
  registerInitialToolFilter(...args);
}

export default finalizeToolExposure;
