import { Component, createSignal, onCleanup, createMemo } from 'solid-js';
import { mdiLightbulbOutline, mdiHandWaveOutline } from '@mdi/js';
import Icon from './Icon';
import { isTouchDevice } from '../lib/mobile';
import { useScrambleText } from '../lib/use-scramble-text';
import { DEV_QUOTES } from '../lib/quotes';
import { formatRelativeTime } from '../lib/format';
import { loadSettings } from '../lib/settings';
import { sessionStore } from '../stores/session';
import type { SessionWithStatus } from '../types';
import '../styles/dashboard-card.css';

interface Tip {
  text: string;
  category: 'mobile' | 'desktop' | 'general';
  /** Tip references a SaaS-only concept (Pro mode, metered usage). Hidden in
   *  onboarding, enterprise, and default deployments, which have no such thing. */
  saasOnly?: boolean;
}

const ALL_TIPS: Tip[] = [
  // Mobile
  { text: 'Swipe left/right in the terminal to move cursor through text', category: 'mobile' },
  { text: 'Swipe up/down in the terminal to navigate command history', category: 'mobile' },
  { text: 'Upload and download files from the storage panel', category: 'mobile' },
  { text: 'Add to Home Screen for a standalone app experience', category: 'mobile' },
  { text: 'Toggle terminal button labels in Settings', category: 'mobile' },
  { text: 'Tap the [] button then press a key to send Ctrl+C, Ctrl+B, etc.', category: 'mobile' },
  { text: 'Use the paste button to paste from your clipboard into the terminal', category: 'mobile' },
  { text: 'When a login URL is detected, a special icon appears \u2014 tap it to open automatically', category: 'mobile' },
  // Desktop
  { text: 'Drag and drop files into the storage panel to upload', category: 'desktop' },
  { text: 'Drag tabs in the terminal to reorder them. Tab 1 stays fixed', category: 'desktop' },
  { text: 'Use the tiling button in the terminal to split into 2-panel, 3-panel, or grid', category: 'desktop' },
  { text: 'Accent color picker in Settings customizes the entire UI', category: 'desktop' },
  { text: 'Pre-installed terminal tools: lazygit, tmux, neovim, yazi, htop, fzf, ripgrep, gh and more', category: 'desktop' },
  // General
  { text: 'Save your favourite terminal tab configurations with bookmark profiles', category: 'general' },
  { text: 'Load a bookmark to restore terminal tabs and auto-launch commands', category: 'general' },
  { text: 'Coding agent credentials sync to storage for Single-Sign-On on every device', category: 'general' },
  { text: 'Your agent configuration is persisted across sessions and devices automatically', category: 'general' },
  { text: 'Enable workspace sync in Settings \u2014 never lose code changes again', category: 'general' },
  { text: 'Getting Started guide and example projects are preloaded in the storage panel', category: 'general' },
  { text: 'Use GitHub Actions to build and deploy \u2014 ask your agent to set it up', category: 'general' },
  { text: 'Connect your GitHub account in Settings to push code from every session', category: 'general' },
  { text: 'Connect your Cloudflare account in Settings to deploy from every session', category: 'general' },
  { text: 'Switch to Pro mode in Settings to unlock persistent memory across sessions', category: 'general', saasOnly: true },
  { text: 'Change your idle timeout in Settings \u2014 from 5 minutes to 2 hours', category: 'general' },
  { text: 'Check your compute usage on the Usage page', category: 'general', saasOnly: true },
  { text: 'Your files sync to R2 every 60 seconds \u2014 safe even if your session dies', category: 'general' },
  { text: 'Ask your agent to build a Cloudflare Workers project and deploy it for you', category: 'general' },
  { text: 'Try Spec-Driven Development \u2014 type /sdd init in Claude Code to get started', category: 'general' },
  // Engine capabilities present in every deployment mode.
  { text: 'Ask the lead agent to delegate: architect, code reviewer, security, and a TDD guide work in parallel', category: 'general' },
  { text: 'Open a pull request and the code, spec, and doc reviewers run in parallel before you merge', category: 'general' },
  { text: 'Agents can drive a real browser and test your deployed app end to end \u2014 just describe the flow', category: 'general' },
  { text: 'Your repos, docs, and decisions become a queryable knowledge graph the agent recalls across sessions', category: 'general' },
  { text: 'Close the tab and the session keeps working \u2014 reconnect from any device to steer it', category: 'general' },
  { text: 'Agents load skills on demand: spec-driven dev, CI monitoring, deploys, and security checklists', category: 'general' },
  { text: 'Pick any agent \u2014 Claude Code, Codex, Copilot, Pi \u2014 the governance and scaffolding stay identical', category: 'general' },
];

/** Fisher-Yates shuffle — returns a new shuffled array */
function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function filterTips(saasMode: boolean): Tip[] {
  const touch = isTouchDevice();
  const filtered = ALL_TIPS.filter((tip) => {
    // SaaS-only tips (Pro mode, metered usage) make no sense in onboarding,
    // enterprise, or default deployments, which have no such concept.
    if (tip.saasOnly && !saasMode) return false;
    return tip.category === 'general' || (touch ? tip.category === 'mobile' : tip.category === 'desktop');
  });
  return shuffle(filtered);
}

const ROTATION_INTERVAL_MS = 15_000;

interface DashboardCardProps {
  sessions?: SessionWithStatus[];
}

const TipsCard: Component = () => {
  const tips = filterTips(sessionStore.saasMode);
  const [index, setIndex] = createSignal(0);

  const currentText = createMemo(() => tips[index()]?.text ?? '');
  const displayText = useScrambleText(currentText);

  const advance = () => {
    setIndex((i) => (i + 1) % tips.length);
  };

  const timer = setInterval(advance, ROTATION_INTERVAL_MS);
  onCleanup(() => clearInterval(timer));

  let touchStartX = 0;
  const handleTouchStart = (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: TouchEvent) => {
    const delta = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(delta) > 30) advance();
  };

  return (
    <div
      class="stat-card tips-card"
      data-testid="tips-card"
      onClick={advance}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div class="stat-card__header">
        <Icon path={mdiLightbulbOutline} size={14} class="stat-card__icon" />
        <span class="stat-card__title type-section-header">TIPS & TRICKS</span>
      </div>
      <div class="dashboard-card__content">
        <span class="dashboard-card__text type-body">{displayText()}</span>
      </div>
    </div>
  );
};

const WelcomeCard: Component<{ sessions?: SessionWithStatus[] }> = (props) => {
  const [quoteIndex, setQuoteIndex] = createSignal(0);

  const currentQuoteText = createMemo(() => {
    const q = DEV_QUOTES[quoteIndex()];
    return q ? `"${q.text}" - ${q.author}` : '';
  });
  const displayQuote = useScrambleText(currentQuoteText);

  const lastSessionTime = createMemo(() => {
    const sessions = props.sessions;
    if (!sessions || sessions.length === 0) return null;
    const sorted = [...sessions].sort((a, b) => {
      const ta = new Date(a.lastAccessedAt || a.createdAt).getTime();
      const tb = new Date(b.lastAccessedAt || b.createdAt).getTime();
      return tb - ta;
    });
    return new Date(sorted[0].lastAccessedAt || sorted[0].createdAt);
  });

  const advance = () => {
    setQuoteIndex((i) => (i + 1) % DEV_QUOTES.length);
  };

  const timer = setInterval(advance, ROTATION_INTERVAL_MS);
  onCleanup(() => clearInterval(timer));

  let touchStartX = 0;
  const handleTouchStart = (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: TouchEvent) => {
    const delta = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(delta) > 30) advance();
  };

  return (
    <div
      class="stat-card welcome-card"
      data-testid="welcome-card"
      onClick={advance}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div class="stat-card__header">
        <Icon path={mdiHandWaveOutline} size={14} class="stat-card__icon" />
        <span class="stat-card__title type-section-header">WELCOME BACK</span>
      </div>
      <div class="dashboard-card__content">
        {lastSessionTime() && (
          <span class="dashboard-card__text--static">
            Last session {formatRelativeTime(lastSessionTime()!)}
          </span>
        )}
        <span class="dashboard-card__text type-body">{displayQuote()}</span>
      </div>
    </div>
  );
};

const DashboardCard: Component<DashboardCardProps> = (props) => {
  const showTips = loadSettings().showTips !== false;

  if (showTips) {
    return <TipsCard />;
  }
  return <WelcomeCard sessions={props.sessions} />;
};

export default DashboardCard;
