import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock SpeechRecognition before importing module
let mockRecognition: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onresult: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
};

function createMockRecognition() {
  mockRecognition = {
    start: vi.fn(),
    stop: vi.fn(),
    onresult: null,
    onend: null,
    onerror: null,
    lang: '',
    continuous: false,
    interimResults: false,
    maxAlternatives: 1,
  };
  return mockRecognition;
}

describe('speech-input', () => {
  let mod: typeof import('../../lib/speech-input');

  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).webkitSpeechRecognition;
    delete (globalThis as Record<string, unknown>).SpeechRecognition;
  });

  describe('when SpeechRecognition is NOT available', () => {
    beforeEach(async () => {
      mod = await import('../../lib/speech-input');
    });

    it('isSpeechSupported returns false', () => {
      expect(mod.isSpeechSupported()).toBe(false);
    });

    it('startListening returns false', () => {
      expect(mod.startListening(vi.fn())).toBe(false);
    });

    it('isListening returns false', () => {
      expect(mod.isListening()).toBe(false);
    });
  });

  describe('when webkitSpeechRecognition is available', () => {
    beforeEach(async () => {
      (globalThis as Record<string, unknown>).webkitSpeechRecognition = vi.fn(createMockRecognition);
      mod = await import('../../lib/speech-input');
    });

    it('isSpeechSupported returns true', () => {
      expect(mod.isSpeechSupported()).toBe(true);
    });

    it('startListening calls recognition.start and returns true', () => {
      const result = mod.startListening(vi.fn());
      expect(result).toBe(true);
      expect(mockRecognition.start).toHaveBeenCalled();
      expect(mod.isListening()).toBe(true);
    });

    it('startListening returns false if already listening', () => {
      mod.startListening(vi.fn());
      expect(mod.startListening(vi.fn())).toBe(false);
    });

    it('stopListening calls recognition.stop', () => {
      mod.startListening(vi.fn());
      mod.stopListening();
      expect(mockRecognition.stop).toHaveBeenCalled();
      expect(mod.isListening()).toBe(false);
    });

    it('stopListening is safe when not listening', () => {
      mod.stopListening();
      expect(mod.isListening()).toBe(false);
    });

    it('onresult sends final text to callback', () => {
      const callback = vi.fn();
      mod.startListening(callback);

      mockRecognition.onresult!({
        resultIndex: 0,
        results: [{ 0: { transcript: ' hello world ' }, isFinal: true, length: 1 }],
      });

      expect(callback).toHaveBeenCalledWith('hello world');
    });

    it('onresult ignores non-final results', () => {
      const callback = vi.fn();
      mod.startListening(callback);

      mockRecognition.onresult!({
        resultIndex: 0,
        results: [{ 0: { transcript: 'hel' }, isFinal: false, length: 1 }],
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('onresult ignores empty transcript', () => {
      const callback = vi.fn();
      mod.startListening(callback);

      mockRecognition.onresult!({
        resultIndex: 0,
        results: [{ 0: { transcript: '   ' }, isFinal: true, length: 1 }],
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('onend resets listening state and calls onEnd callback', () => {
      const onEnd = vi.fn();
      mod.startListening(vi.fn(), onEnd);
      expect(mod.isListening()).toBe(true);

      mockRecognition.onend!();
      expect(mod.isListening()).toBe(false);
      expect(onEnd).toHaveBeenCalled();
    });

    it('onerror resets listening state and calls onEnd callback', () => {
      const onEnd = vi.fn();
      mod.startListening(vi.fn(), onEnd);
      expect(mod.isListening()).toBe(true);

      mockRecognition.onerror!({ error: 'not-allowed' });
      expect(mod.isListening()).toBe(false);
      expect(onEnd).toHaveBeenCalled();
    });

    it('startListening returns false if recognition.start() throws', async () => {
      (globalThis as Record<string, unknown>).webkitSpeechRecognition = vi.fn(() => {
        const r = createMockRecognition();
        r.start = vi.fn(() => { throw new Error('already started'); });
        return r;
      });
      vi.resetModules();
      const freshMod = await import('../../lib/speech-input');
      expect(freshMod.startListening(vi.fn())).toBe(false);
      expect(freshMod.isListening()).toBe(false);
    });

    it('configures recognition with correct defaults', () => {
      mod.startListening(vi.fn());
      expect(mockRecognition.continuous).toBe(false);
      expect(mockRecognition.interimResults).toBe(false);
      expect(mockRecognition.maxAlternatives).toBe(1);
    });
  });
});
