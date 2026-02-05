import { Component, createSignal, onCleanup, createMemo } from 'solid-js';
import { mdiLightbulbOutline, mdiHandWaveOutline } from '@mdi/js';
import Icon from './Icon';
import { isTouchDevice } from '../lib/mobile';
import { useScrambleText } from '../lib/use-scramble-text';
import { DEV_QUOTES } from '../lib/quotes';
import { formatRelativeTime } from '../lib/format';
import { loadSettings } from '../lib/settings';
import type { SessionWithStatus } from '../types';
import '../styles/dashboard-card.css';

interface Tip {
  text: string;
  category: 'mobile' | 'desktop' | 'general';
}

const ALL_TIPS: Tip[] = [
  // Mobile
  { text: 'Swipe left/right in the terminal to move cursor through text', category: 'mobile' },
  { text: 'Swipe up/down in the terminal to navigate command history', category: 'mobile' },
  { text: 'Upload and download files from the storage panel', category: 'mobile' },
  { text: 'Add to Home Screen for a standalone app experience', category: 'mobile' },
  { text: 'Toggle terminal button labels in Settings', category: 'mobile' },
  // Desktop
  { text: 'Drag and drop files into the storage panel to upload', category: 'desktop' },
  { text: 'Drag tabs in the terminal to reorder them. Tab 1 stays fixed', category: 'desktop' },
  { text: 'Use the tiling button in the terminal to split into 2-panel, 3-panel, or grid', category: 'desktop' },
  { text: 'Accent color picker in Settings customizes the entire UI', category: 'desktop' },
  { text: 'Pre-installed terminal tools: lazygit, tmux, neovim, yazi, htop, fzf, ripgrep, gh and more', category: 'desktop' },
  // General
  { text: 'Storage panel syncs to Cloudflare R2 automatically', category: 'general' },
  { text: 'Save your favourite terminal tab configurations with bookmark profiles', category: 'general' },
  { text: 'Load a bookmark to restore terminal tabs and auto-launch commands', category: 'general' },
  { text: 'Selection mode in the storage panel allows batch deletes and downloads', category: 'general' },
  { text: 'Coding agent credentials sync to storage for Single-Sign-On on every device', category: 'general' },
  { text: 'Agent config, skills, rules and MCP servers sync to storage automatically', category: 'general' },
  { text: 'Enable workspace sync in Settings \u2014 never lose code changes again', category: 'general' },
  { text: 'Chunked uploads let you upload large files from the storage panel', category: 'general' },
  { text: 'Getting Started guide and example projects are preloaded in the storage panel', category: 'general' },
  { text: 'Use GitHub Actions to build and deploy \u2014 ask your agent to set it up', category: 'general' },
];

function filterTips(): Tip[] {
  const touch = isTouchDevice();
  return ALL_TIPS.filter(
    (tip) => tip.category === 'general' || (touch ? tip.category === 'mobile' : tip.category === 'desktop'),
  );
}

const ROTATION_INTERVAL_MS = 15_000;

interface DashboardCardProps {
  sessions?: SessionWithStatus[];
}

const TipsCard: Component = () => {
  const tips = filterTips();
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
        <span class="stat-card__title">TIPS & TRICKS</span>
      </div>
      <div class="dashboard-card__content">
        <span class="dashboard-card__text">{displayText()}</span>
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
        <span class="stat-card__title">WELCOME BACK</span>
      </div>
      <div class="dashboard-card__content">
        {lastSessionTime() && (
          <span class="dashboard-card__text--static">
            Last session {formatRelativeTime(lastSessionTime()!)}
          </span>
        )}
        <span class="dashboard-card__text">{displayQuote()}</span>
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
