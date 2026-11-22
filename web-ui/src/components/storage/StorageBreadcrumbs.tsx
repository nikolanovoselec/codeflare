import { Component, For, Show, createEffect, onCleanup } from 'solid-js';
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
  let rail!: HTMLElement;
  createEffect(() => {
    if (!props.currentPrefix || !window.matchMedia?.('(min-width: 1024px)').matches) return;
    const frame = requestAnimationFrame(() => {
      const end = rail.scrollWidth - rail.clientWidth;
      if (end > 0) rail.scrollTo({ left: end, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
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
      <nav ref={rail} class="storage-breadcrumbs" aria-label="Storage path" data-testid="storage-breadcrumbs">
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
                aria-current={crumb === props.currentPrefix ? 'location' : undefined}
                title={crumb === props.currentPrefix ? props.currentPrefix : undefined}
                onClick={() => storageStore.navigateTo(crumb)}
              >
                {getBreadcrumbName(crumb)}
              </button>
            </>
          )}
        </For>
      </nav>
    </>
  );
};

export default StorageBreadcrumbs;
