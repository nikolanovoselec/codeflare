import type { Component, JSX, ParentComponent } from 'solid-js';
import Icon from './Icon';
import '../styles/stat-cards.css';

interface StatCardProps {
  icon: string;
  title: JSX.Element;
  testId?: string;
}

export const StatCard: ParentComponent<StatCardProps> = props => (
  <div class="stat-card stat-card--three-metrics" data-testid={props.testId}>
    <div class="stat-card__header">
      <Icon path={props.icon} size={14} class="stat-card__icon" aria-hidden="true" />
      {props.title}
    </div>
    {props.children}
  </div>
);

interface StatCardMetricProps {
  label: JSX.Element;
  value: JSX.Element;
  testId?: string;
}

export const StatCardMetric: Component<StatCardMetricProps> = props => (
  <div class="stat-card__metric" data-testid={props.testId}>
    {props.label}
    {props.value}
  </div>
);
