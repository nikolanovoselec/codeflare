interface VsCodeApi {
  postMessage(message: unknown): void;
}

const MAX_TRANSCRIPT_CHARS = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 500;
const MAX_ENTRY_CHARS = 256 * 1024;
const transcriptSizes = new WeakMap<HTMLElement, number>();

declare function acquireVsCodeApi(): VsCodeApi;

export function mountPiChat(root: HTMLElement, api: VsCodeApi = acquireVsCodeApi()): void {
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const newButton = button('New conversation', () => api.postMessage({ type: 'newConversation' }));
  const modelButton = button('Cycle model', () => api.postMessage({ type: 'pi.cycleModel' }));
  const thinkingButton = button('Cycle thinking', () => api.postMessage({ type: 'pi.cycleThinking' }));
  const abortButton = button('Stop', () => api.postMessage({ type: 'abort' }));
  toolbar.append(newButton, modelButton, thinkingButton, abortButton);

  const transcript = document.createElement('div');
  transcript.className = 'transcript';
  transcript.setAttribute('role', 'log');
  transcript.setAttribute('aria-live', 'polite');

  const form = document.createElement('form');
  form.className = 'prompt-form';
  const prompt = document.createElement('textarea');
  prompt.name = 'prompt';
  prompt.rows = 4;
  prompt.required = true;
  prompt.maxLength = 65_536;
  prompt.setAttribute('aria-label', 'Message Pi');
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = 'Send';
  form.append(prompt, send);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = prompt.value;
    if (!message) return;
    appendTranscript(transcript, 'You', message);
    api.postMessage({ type: 'prompt', message });
    prompt.value = '';
  });

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isRecord(message) || typeof message.type !== 'string') return;
    if (message.type === 'conversation.reset') {
      transcript.replaceChildren();
      transcriptSizes.set(transcript, 0);
      return;
    }
    if (message.type === 'pi.output' && typeof message.text === 'string') {
      appendTranscript(transcript, 'Pi', message.text);
      return;
    }
    if (message.type === 'sidebar.error' && typeof message.message === 'string') {
      appendTranscript(transcript, 'System', message.message);
    }
  });

  root.replaceChildren(toolbar, transcript, form);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function appendTranscript(root: HTMLElement, speaker: string, text: string): void {
  const boundedText = text.slice(0, MAX_ENTRY_CHARS);
  const previous = root.lastElementChild;
  if (speaker === 'Pi' && previous instanceof HTMLElement && previous.dataset.speaker === speaker) {
    const body = previous.querySelector('pre');
    if (body && (body.textContent?.length ?? 0) + boundedText.length <= MAX_ENTRY_CHARS) {
      body.textContent = `${body.textContent ?? ''}${boundedText}`;
      previous.dataset.characters = String(body.textContent.length);
      transcriptSizes.set(root, (transcriptSizes.get(root) ?? 0) + boundedText.length);
      trimTranscript(root);
      previous.scrollIntoView({ block: 'end' });
      return;
    }
  }

  const entry = document.createElement('section');
  entry.className = 'message';
  entry.dataset.speaker = speaker;
  entry.dataset.characters = String(boundedText.length);
  const heading = document.createElement('strong');
  heading.textContent = speaker;
  const body = document.createElement('pre');
  body.textContent = boundedText;
  entry.append(heading, body);
  root.append(entry);
  transcriptSizes.set(root, (transcriptSizes.get(root) ?? 0) + boundedText.length);
  trimTranscript(root);
  entry.scrollIntoView({ block: 'end' });
}

function trimTranscript(root: HTMLElement): void {
  let characters = transcriptSizes.get(root) ?? 0;
  while (root.childElementCount > MAX_TRANSCRIPT_ENTRIES || characters > MAX_TRANSCRIPT_CHARS) {
    const first = root.firstElementChild;
    if (!(first instanceof HTMLElement)) break;
    characters -= Number(first.dataset.characters ?? first.textContent?.length ?? 0);
    first.remove();
  }
  transcriptSizes.set(root, Math.max(0, characters));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const root = document.getElementById('app');
if (root) mountPiChat(root);
