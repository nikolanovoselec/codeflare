import { Component, For } from 'solid-js';
import '../styles/plan-page.css';

interface TierDisplay {
  id: string;
  name: string;
  hours: string;
  sessions: number;
  modes: string;
  price: string;
}

const TIERS: TierDisplay[] = [
  { id: 'free', name: 'Free', hours: '2h', sessions: 1, modes: 'Default', price: 'Free' },
  { id: 'trial', name: 'Trial', hours: '5h', sessions: 2, modes: 'Default', price: 'Free' },
  { id: 'standard', name: 'Standard', hours: '10h', sessions: 3, modes: 'Default', price: '$29/mo' },
  { id: 'advanced', name: 'Advanced', hours: '50h', sessions: 5, modes: 'Default + Advanced', price: '$79/mo' },
  { id: 'max', name: 'Max', hours: '200h', sessions: 10, modes: 'Default + Advanced', price: '$199/mo' },
  { id: 'unlimited', name: 'Unlimited', hours: 'Unlimited', sessions: 10, modes: 'Default + Advanced', price: 'Contact us' },
];

const PlanPage: Component = () => {
  return (
    <div class="login-page">
      <div class="login-particles login-particles--1" />
      <div class="login-particles login-particles--2" />

      <div class="login-content plan-content">
        <h1 class="plan-title">Plans</h1>
        <p class="plan-subtitle">Choose the plan that fits your needs.</p>

        <div class="plan-grid">
          <For each={TIERS}>
            {(tier) => (
              <div class="plan-card" classList={{ 'plan-card--highlight': tier.id === 'standard' }}>
                <div class="plan-card-header">
                  <h2 class="plan-card-name">{tier.name}</h2>
                  <div class="plan-card-price">{tier.price}</div>
                </div>
                <div class="plan-card-features">
                  <div class="plan-card-feature">
                    <span class="plan-card-feature-label">Monthly Hours</span>
                    <span class="plan-card-feature-value">{tier.hours}</span>
                  </div>
                  <div class="plan-card-feature">
                    <span class="plan-card-feature-label">Concurrent Sessions</span>
                    <span class="plan-card-feature-value">{tier.sessions}</span>
                  </div>
                  <div class="plan-card-feature">
                    <span class="plan-card-feature-label">Session Modes</span>
                    <span class="plan-card-feature-value">{tier.modes}</span>
                  </div>
                </div>
                <button type="button" class="plan-card-btn" disabled>
                  Coming soon
                </button>
              </div>
            )}
          </For>
        </div>

        <div class="plan-actions">
          <a href="/app/usage" class="usage-btn usage-btn--secondary">View Usage</a>
          <a href="/app/" class="usage-btn">Back to Dashboard</a>
        </div>
      </div>
    </div>
  );
};

export default PlanPage;
