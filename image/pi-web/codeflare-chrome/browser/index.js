import { activateTranscriptIntent } from './transcript-intent.js';

// The pinned stock notice uses identical markup for stale and failed refreshes
// and does not reflect its state. Mark only stale notices for presentation.
function hideStaleConversationNotice({ lifetimeSignal }) {
  const app = document.querySelector('pi-web-app')?.shadowRoot;
  if (!app) return;
  let notice;
  const refresh = () => notice?.toggleAttribute('data-codeflare-stale', notice.state === 'stale');
  const warningObserver = new MutationObserver(refresh);
  const findNotice = () => {
    const next = app.querySelector('conversation-sync-notice');
    if (next === notice) return;
    warningObserver.disconnect();
    notice = next;
    if (notice?.shadowRoot) warningObserver.observe(notice.shadowRoot, { subtree: true, childList: true, characterData: true });
    refresh();
  };
  const appObserver = new MutationObserver(findNotice);
  appObserver.observe(app, { childList: true, subtree: true });
  findNotice();
  lifetimeSignal.addEventListener('abort', () => {
    appObserver.disconnect();
    warningObserver.disconnect();
    notice?.removeAttribute('data-codeflare-stale');
  }, { once: true });
}

// Use the pinned context bar's session summary, not the rendered text alone:
// an authored name or first message can itself be "(no messages)".
function hideEmptySessionTitle({ lifetimeSignal }) {
  const app = document.querySelector('pi-web-app')?.shadowRoot;
  if (!app) return;
  let bar;
  const mark = () => {
    const session = bar?.session;
    bar?.toggleAttribute('data-codeflare-empty-session', session?.messageCount === 0
      && !session.name?.trim() && session.firstMessage === '(no messages)');
  };
  // Lit calls hostUpdated even when new summary data leaves the title text unchanged.
  const controller = { hostUpdated: mark };
  const detach = () => {
    bar?.removeController?.(controller);
    bar?.removeAttribute('data-codeflare-empty-session');
  };
  const findBar = () => {
    const next = app.querySelector('app-context-bar');
    if (next === bar) return;
    detach();
    bar = next;
    bar?.addController?.(controller);
    mark();
  };
  const observer = new MutationObserver(findBar);
  observer.observe(app, { childList: true, subtree: true });
  findBar();
  lifetimeSignal.addEventListener('abort', () => {
    observer.disconnect();
    detach();
  }, { once: true });
}

export default {
  apiVersion: 5,
  name: 'Codeflare Chat presentation',
  activate(context) {
    activateTranscriptIntent(context);
    hideStaleConversationNotice(context);
    hideEmptySessionTitle(context);
    return { contributions: {
      stylesheets: [{ id: 'footer', url: new URL('./footer.css', import.meta.url).href }],
    } };
  },
};
