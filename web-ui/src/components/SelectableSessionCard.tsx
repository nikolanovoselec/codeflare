import { Component } from 'solid-js';
import SessionStatCard from './SessionStatCard';
import type { SessionWithStatus } from '../types';
import '../styles/session-dropdown.css';

interface SelectableSessionCardProps {
  session: SessionWithStatus;
  isActive: boolean;
  selected: boolean;
  selecting: boolean;
  disabled: boolean;
  onSelect: () => void;
  onStop: () => void;
  onDelete: () => void;
  onMenuClick?: (e: MouseEvent, session: SessionWithStatus) => void;
}

const SelectableSessionCard: Component<SelectableSessionCardProps> = (props) => (
  <div
    data-testid={`session-card-${props.session.id}`}
    data-selected={props.selected ? 'true' : 'false'}
    data-selecting={props.selecting ? 'true' : 'false'}
    data-disabled={props.disabled ? 'true' : 'false'}
    class={`session-dropdown__selectable-card ${props.selected ? 'session-dropdown__selectable-card--selected' : ''} ${props.disabled ? 'session-dropdown__selectable-card--disabled' : ''}`}
    onClick={(event) => {
      if (event.target === event.currentTarget) props.onSelect();
    }}
  >
    <SessionStatCard
      session={props.session}
      isActive={props.isActive}
      onSelect={props.onSelect}
      onStop={props.onStop}
      onDelete={props.onDelete}
      onMenuClick={props.onMenuClick}
    />
  </div>
);

export default SelectableSessionCard;
