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
function hideEmptySessionTitle(context) {
  markStockControl(context, 'app-context-bar', 'data-codeflare-empty-session', ({ session }) =>
    session?.messageCount === 0 && !session.name?.trim() && session.firstMessage === '(no messages)');
}

// Hide the menu only in Sessions when either visible tab can take the user
// back to a view where the stock menu exposes pin settings.
function hideRedundantNavigation(context) {
  markStockControl(context, 'app-mobile-main-tabs', 'data-codeflare-direct-tabs', ({ tabs, controlsOnly, selectedTab }) =>
    !controlsOnly && selectedTab === 'navigation' && tabs.some(({ id }) => id === 'chat')
      && tabs.some(({ id }) => id === 'files:workspace.files'));
}

function markStockControl({ lifetimeSignal }, selector, attribute, matches) {
  const app = document.querySelector('pi-web-app')?.shadowRoot;
  if (!app) return;
  let host;
  const mark = () => { if (host) host.toggleAttribute(attribute, matches(host)); };
  // Lit calls hostUpdated even when changed data leaves the visible text unchanged.
  const controller = { hostUpdated: mark };
  const detach = () => {
    host?.removeController?.(controller);
    host?.removeAttribute(attribute);
  };
  const findControl = () => {
    const next = app.querySelector(selector);
    if (next === host) return;
    detach();
    host = next;
    host?.addController?.(controller);
    mark();
  };
  const observer = new MutationObserver(findControl);
  observer.observe(app, { childList: true, subtree: true });
  findControl();
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
    hideRedundantNavigation(context);
    return { contributions: {
      stylesheets: [{ id: 'footer', url: new URL('./footer.css', import.meta.url).href }],
    } };
  },
};
