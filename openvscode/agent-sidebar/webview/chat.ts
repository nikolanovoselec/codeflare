interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export function mountPiChat(root: HTMLElement, api: VsCodeApi = acquireVsCodeApi()): void {
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const newButton = button('New conversation', () => api.postMessage({ type: 'newConversation' }));
  const abortButton = button('Stop', () => api.postMessage({ type: 'abort' }));
  toolbar.append(newButton, abortButton);

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
  const entry = document.createElement('section');
  entry.className = 'message';
  const heading = document.createElement('strong');
  heading.textContent = speaker;
  const body = document.createElement('pre');
  body.textContent = text;
  entry.append(heading, body);
  root.append(entry);
  entry.scrollIntoView({ block: 'end' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const root = document.getElementById('app');
if (root) mountPiChat(root);
