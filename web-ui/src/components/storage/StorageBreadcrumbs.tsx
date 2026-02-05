import { Component, For, Show } from 'solid-js';
import { storageStore } from '../../stores/storage';
import Icon from '../Icon';
import { mdiChevronRight, mdiArrowUp } from '@mdi/js';

const getBreadcrumbName = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  const name = parts[parts.length - 1] || 'root';
  return name === 'workspace' ? 'Workspace' : name;
};

interface StorageBreadcrumbsProps {
  currentPrefix: string;
}

const StorageBreadcrumbs: Component<StorageBreadcrumbsProps> = (props) => {
  return (
    <>
      <Show when={props.currentPrefix !== ''}>
        <button
          type="button"
          class="storage-icon-btn"
          data-testid="storage-up-btn"
          title="Go up"
          onClick={() => storageStore.navigateUp()}
        >
          <Icon path={mdiArrowUp} size={16} />
        </button>
      </Show>
      <div class="storage-breadcrumbs" data-testid="storage-breadcrumbs">
        <For each={storageStore.breadcrumbs}>
          {(crumb, index) => (
            <>
              <Show when={index() > 0}>
                <Icon path={mdiChevronRight} size={14} class="breadcrumb-separator" />
              </Show>
              <button
                type="button"
                class="breadcrumb-item"
                data-testid={`breadcrumb-${index()}`}
                onClick={() => storageStore.navigateTo(crumb)}
              >
                {getBreadcrumbName(crumb)}
              </button>
            </>
          )}
        </For>
      </div>
    </>
  );
};

export default StorageBreadcrumbs;
