/**
 * Web Speech API voice input for mobile terminal.
 *
 * Completely decoupled from the keyboard/iframe input system.
 * Recognized text goes directly to terminal.input() via callback.
 * Password input stays untouched — no autocorrect changes needed.
 */

// SpeechRecognition types — not in all TypeScript DOM lib versions.
// Minimal interface covering only the API surface we use.
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface SpeechRecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResult>;
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

const SR: SpeechRecognitionCtor | undefined =
  typeof window !== 'undefined'
    ? ((window as unknown as Record<string, unknown>).SpeechRecognition ??
       (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as SpeechRecognitionCtor | undefined
    : undefined;

let recognition: SpeechRecognitionInstance | null = null;
let listening = false;
let onTextCallback: ((text: string) => void) | null = null;

/** True if the browser supports the Web Speech API. */
export function isSpeechSupported(): boolean {
  return !!SR;
}

/** The temporary trace is enabled only on the Enterprise Integration app. */
export function isVoiceDiagnosticOrigin(origin: string): boolean {
  return origin === 'https://enterprise.codeflare.ch';
}

/** True while speech recognition is actively listening. */
export function isListening(): boolean {
  return listening;
}

/**
 * Check if microphone permission needs prompting (first use).
 * Returns 'granted', 'denied', 'prompt', or 'unknown'.
 */
export async function getMicPermissionState(): Promise<string> {
  try {
    const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return result.state;
  } catch {
    return 'unknown';
  }
}

/**
 * Start speech recognition. Final transcribed text is passed to `onText`.
 * Must be called from a user gesture (click/tap) for permission prompt.
 * Returns true if recognition started, false if unsupported or already listening.
 */
export function startListening(onText: (text: string) => void, onEnd?: () => void, trace?: (event: string) => void): boolean {
  if (!SR || listening) {
    trace?.(SR ? 'recognition already listening' : 'recognition unsupported');
    return false;
  }
  onTextCallback = onText;

  try {
    recognition = new SR();
  } catch (error) {
    if (!trace) throw error;
    trace('recognition constructor threw');
    return false;
  }
  if (trace) recognition.onstart = () => trace('recognition start event');
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        const text = event.results[i][0].transcript.trim();
        if (text && onTextCallback) onTextCallback(text);
      }
    }
  };

  recognition.onend = () => {
    trace?.('recognition end event');
    listening = false;
    onEnd?.();
  };

  recognition.onerror = (event) => {
    if (trace) {
      const code = ['aborted', 'audio-capture', 'bad-grammar', 'language-not-supported', 'network', 'no-speech', 'not-allowed', 'phrases-not-supported', 'service-not-allowed']
        .includes(event.error) ? event.error : 'other';
      trace(`recognition error: ${code}`);
    }
    listening = false;
    onEnd?.();
  };

  try {
    recognition.start();
    trace?.('recognition.start returned');
    listening = true;
    return true;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const code = ['InvalidStateError', 'NotAllowedError', 'NotSupportedError', 'SecurityError'].includes(name) ? name : 'other';
    trace?.(`recognition.start threw: ${code}`);
    listening = false;
    return false;
  }
}

/** Stop speech recognition. Safe to call when not listening. */
export function stopListening(): void {
  if (recognition && listening) {
    recognition.stop();
  }
  listening = false;
  onTextCallback = null;
  recognition = null;
}
