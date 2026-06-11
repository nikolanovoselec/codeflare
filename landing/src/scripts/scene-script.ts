/**
 * The line→action map that choreographs the page from transcript progress.
 * Actions are derived from the transcript content itself (not hardcoded
 * indices), so editing the copy in site.ts can never silently detach the
 * choreography — missing trigger lines throw at build/test time.
 */
export interface SceneAction {
  line: number;
  action: 'split' | 'gw-counter';
  payload?: number;
}

const SPLIT_TRIGGER = 'CI green';

export function buildSceneScript(
  transcript: readonly { text: string }[],
  requestCount: number
): SceneAction[] {
  const splitLine = transcript.findIndex((line) => line.text.includes(SPLIT_TRIGGER));
  const counterLine = transcript.findIndex((line) =>
    line.text.includes(`${requestCount} requests`)
  );

  if (splitLine === -1 || counterLine === -1) {
    throw new Error(
      `transcript no longer carries the scene trigger lines ('${SPLIT_TRIGGER}', '${requestCount} requests')`
    );
  }

  return [
    { line: splitLine, action: 'split' },
    { line: counterLine, action: 'gw-counter', payload: requestCount },
  ];
}
