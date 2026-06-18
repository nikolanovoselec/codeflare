import { Component } from 'solid-js';
import { mdiMonitorMultiple } from '@mdi/js';
import Icon from './Icon';
import type { MultiViewWorkspace } from '../types';
import '../styles/stat-cards.css';
import '../styles/session-stat-card.css';

interface MultiViewSessionCardProps {
  workspace: MultiViewWorkspace;
  onSelect: () => void;
}

const MultiViewSessionCard: Component<MultiViewSessionCardProps> = (props) => (
  <div
    class="stat-card session-stat-card session-stat-card--multiview"
    data-testid="dashboard-multiview-card"
    data-workspace-id={props.workspace.id}
    data-status="running"
    onClick={props.onSelect}
  >
    <div class="stat-card__header">
      <span class="stat-card__icon">
        <Icon path={mdiMonitorMultiple} size={14} />
      </span>
      <span class="stat-card__title type-section-header session-stat-card__name">{props.workspace.name}</span>
      <span class="session-stat-card__dot session-stat-card__dot--success session-stat-card__dot--pulse" />
    </div>
    <div class="stat-card__metrics">
      <div class="stat-card__metric" data-testid="dashboard-multiview-card-members">
        <span class="stat-card__metric-label">PANES</span>
        <span class="stat-card__metric-value">{props.workspace.memberSessionIds.length}</span>
      </div>
    </div>
  </div>
);

export default MultiViewSessionCard;
