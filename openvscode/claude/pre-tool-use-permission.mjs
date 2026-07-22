export const MAX_HOOK_INPUT_BYTES = 64 * 1024;
export const MAX_HOOK_OUTPUT_BYTES = 4 * 1024;

export function evaluatePreToolUse(_input) {
  throw new Error("NOT_IMPLEMENTED: pre-tool-use permission decision");
}

export async function runPreToolUse(_rawInput, _dependencies = {}) {
  throw new Error("NOT_IMPLEMENTED: pre-tool-use permission hook");
}
