import { describe, expect, it } from 'vitest';

import { composeCodeflareBaseSystemPrompt } from '../../../preseed/agents/pi/extensions/codeflare-pi';

describe('Pi base system prompt composition', () => {
  it('REQ-AGENT-065 AC2: composes the constitution into every Pi base system prompt', () => {
    const withExistingPrompt = composeCodeflareBaseSystemPrompt('existing system instructions');
    const withoutExistingPrompt = composeCodeflareBaseSystemPrompt('');

    expect(withExistingPrompt.startsWith('existing system instructions\n\n')).toBe(true);
    expect(withExistingPrompt.match(/<codeflare_constitution>/g)).toHaveLength(1);
    expect(withExistingPrompt.match(/<\/codeflare_constitution>/g)).toHaveLength(1);
    expect(withoutExistingPrompt.startsWith('<codeflare_constitution>')).toBe(true);
    expect(withoutExistingPrompt.endsWith('</codeflare_constitution>')).toBe(true);
  });
});
