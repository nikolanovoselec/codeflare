import { Component, For, Show } from 'solid-js';
import { mdiCheck } from '@mdi/js';
import Icon from '../Icon';

export type SetupJourneyPage = 'readiness' | 'access' | 'ai' | 'platform' | 'managed' | 'integrations' | 'review' | 'apply';

const PAGES: Array<{ id: SetupJourneyPage; label: string; enterpriseOnly?: boolean }> = [
  { id: 'readiness', label: 'Readiness' },
  { id: 'access', label: 'Access' },
  { id: 'ai', label: 'AI routing', enterpriseOnly: true },
  { id: 'platform', label: 'Platform', enterpriseOnly: true },
  { id: 'managed', label: 'Managed environment' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'review', label: 'Review' },
  { id: 'apply', label: 'Apply' },
];

interface SetupJourneyNavProps {
  active: SetupJourneyPage;
  enterprise?: boolean;
}

const SetupJourneyNav: Component<SetupJourneyNavProps> = (props) => {
  const visiblePages = () => PAGES.filter((page) => !page.enterpriseOnly || props.enterprise);
  const activeIndex = () => visiblePages().findIndex((page) => page.id === props.active);

  return (
    <aside class="setup-journey-rail" aria-label="First-run setup progress">
      <div class="setup-journey-kicker">First-run setup</div>
      <div class="setup-journey-summary">Complete provisioning</div>
      <ol class="setup-journey-list">
        <For each={visiblePages()}>{(page, index) => (
          <li
            class="setup-journey-item"
            classList={{
              'setup-journey-item--active': page.id === props.active,
              'setup-journey-item--complete': index() < activeIndex(),
            }}
            aria-current={page.id === props.active ? 'step' : undefined}
          >
            <span class="setup-journey-marker">
              <Show when={index() < activeIndex()} fallback={index() + 1}>
                <Icon path={mdiCheck} size={12} />
              </Show>
            </span>
            <span>{page.label}</span>
          </li>
        )}</For>
      </ol>
    </aside>
  );
};

export default SetupJourneyNav;
