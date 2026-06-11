import { describe, it, expect } from 'vitest';
import { buildSceneScript } from '../scripts/scene-script';
import { REQUEST_COUNT, TERMINAL_TRANSCRIPT } from '../content/site';

describe('scene-script', () => {
  it('binds the split to the CI-green line of the real transcript', () => {
    const script = buildSceneScript(TERMINAL_TRANSCRIPT, REQUEST_COUNT);

    const split = script.find((action) => action.action === 'split');
    expect(split).toBeDefined();
    expect(TERMINAL_TRANSCRIPT[split!.line].text).toContain('CI green');
  });

  it('binds the gateway counter to the attribution line, payload equal to the copy (count integrity)', () => {
    const script = buildSceneScript(TERMINAL_TRANSCRIPT, REQUEST_COUNT);

    const counter = script.find((action) => action.action === 'gw-counter');
    expect(counter).toBeDefined();
    expect(counter!.payload).toBe(REQUEST_COUNT);
    expect(TERMINAL_TRANSCRIPT[counter!.line].text).toContain(`${REQUEST_COUNT} requests`);
  });

  it('every action references a real transcript line', () => {
    const script = buildSceneScript(TERMINAL_TRANSCRIPT, REQUEST_COUNT);

    for (const action of script) {
      expect(action.line).toBeGreaterThanOrEqual(0);
      expect(action.line).toBeLessThan(TERMINAL_TRANSCRIPT.length);
    }
  });

  it('throws when the transcript no longer carries the trigger lines (drift guard)', () => {
    expect(() => buildSceneScript([{ text: 'unrelated' }], REQUEST_COUNT)).toThrow(/transcript/i);
  });
});
