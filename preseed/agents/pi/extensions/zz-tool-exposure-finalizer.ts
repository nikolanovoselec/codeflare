import { registerInitialToolFilter } from "./capability-helpers";

export function finalizeToolExposure(...args: Parameters<typeof registerInitialToolFilter>): void {
  registerInitialToolFilter(...args);
  args[0].on("tool_call", (event) => {
    if (event && typeof event === "object" && Reflect.get(event, "toolName") === "goal_wait") {
      return { block: true, reason: "goal_wait is disabled by Codeflare policy." };
    }
  });
}

export default finalizeToolExposure;
