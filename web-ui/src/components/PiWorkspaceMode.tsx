import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { mdiCheck, mdiChevronDown, mdiFormDropdown } from '@mdi/js';
import { Portal } from 'solid-js/web';
import type { PiSurface } from '../types';
import Icon from './Icon';
import ScrambleText from './ScrambleText';
import { createTerminalViewportClass } from '../lib/mobile';
import { HEADER_ICON_SLOT } from '../lib/header-fit';
import '../styles/header.css';
import '../styles/session-switcher.css';

const choices = [
  { value: 'chat', name: 'Vibe' },
  { value: 'terminal', name: 'Code' },
] as const;

type Choice = typeof choices[number];
const label = (choice: Choice) => `${choice.name} Mode`;

export interface PiWorkspaceModeBinding {
  value: PiSurface;
  disabled?: boolean;
  pendingTarget?: PiSurface;
  onSelect: (value: PiSurface) => void;
}

export default function PiWorkspaceMode(props: PiWorkspaceModeBinding & { presentation?: 'text' | 'icon'; fitContainer?: boolean }) {
  const viewport = createTerminalViewportClass();
  const preferred = () => props.presentation ?? (viewport() === 'mobile' ? 'icon' : 'text');
  const [compact, setCompact] = createSignal(false);
  const presentation = () => compact() ? 'icon' : preferred();
  const [open, setOpen] = createSignal(false);
  const current = () => props.value === 'chat' ? choices[0] : choices[1];
  let root: HTMLDivElement | undefined;
  let labelMeasure: HTMLSpanElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let popup: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<{ top: number; right: number }>();

  onMount(() => {
    const actions = root?.parentElement;
    const header = actions?.parentElement;
    if (!props.fitContainer || !header || !actions || !root || typeof ResizeObserver === 'undefined') return;
    const slot = root;
    if (!labelMeasure) return;
    const labelBox = labelMeasure;
    const pixels = (value: string) => Number.parseFloat(value) || 0;
    const measure = () => {
      if (!header.clientWidth || preferred() === 'icon') { setCompact(false); return; }
      const textWidth = labelBox.getBoundingClientRect().width;
      const headerStyle = getComputedStyle(header);
      const room = header.clientWidth - pixels(headerStyle.paddingLeft) - pixels(headerStyle.paddingRight);
      const siblings = [...actions.children].filter(child => child !== slot && child.getClientRects().length);
      const actionWidth = siblings.reduce((total, child) => total + child.getBoundingClientRect().width, 0);
      const leftWidth = [...header.children].filter(child => child !== actions && !child.classList.contains('header-spacer'))
        .reduce((total, child) => total + child.getBoundingClientRect().width, 0);
      const gaps = siblings.length * pixels(getComputedStyle(actions).columnGap);
      setCompact(textWidth > room - leftWidth - actionWidth - gaps - HEADER_ICON_SLOT);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(actions);
    observer.observe(labelBox);
    for (const child of header.children) if (child !== actions) observer.observe(child);
    createEffect(() => {
      current();
      measure();
    });
    onCleanup(() => observer.disconnect());
  });

  const triggerDisabled = () => props.disabled && !props.pendingTarget;
  createEffect(() => {
    if (open() && triggerDisabled()) setOpen(false);
  });

  const close = () => {
    setOpen(false);
    trigger?.focus();
  };
  createEffect((previous: PiSurface) => {
    const active = props.value;
    if (active !== previous && open()) close();
    return active;
  }, props.value);
  const toggle = () => {
    if (open()) { close(); return; }
    const rect = trigger?.getBoundingClientRect();
    setPosition(rect ? { top: rect.bottom + 8, right: Math.max(0, window.innerWidth - rect.right) } : undefined);
    setOpen(true);
  };
  const select = (value: PiSurface) => {
    if (value !== props.value) props.onSelect(value);
    if (props.pendingTarget) trigger?.focus();
    else if (open()) close();
  };

  const triggerLabel = () => <>
    <span>{label(current())}</span><Icon path={mdiChevronDown} size={18} aria-hidden="true" />
  </>;

  return (
    <div class="session-switcher-wrapper" ref={root}>
      <Show when={props.fitContainer}>
        <span class="session-switcher workspace-mode-label-measure" ref={labelMeasure} aria-hidden="true">
          {triggerLabel()}
        </span>
      </Show>
      <button ref={trigger} type="button" data-workspace-mode-focus
        classList={{ 'session-switcher': true, 'session-switcher--mobile': presentation() === 'icon' }}
        aria-label={`Workspace mode: ${label(current())}`} aria-expanded={open()}
        disabled={triggerDisabled()} onClick={toggle}
        onKeyDown={event => { if (event.key === 'Escape' && open()) { event.stopPropagation(); close(); } }}>
        <Show when={presentation() === 'text'} fallback={<Icon path={mdiFormDropdown} size={22} aria-hidden="true" />}>
          {triggerLabel()}
        </Show>
      </button>
      <span class="workspace-mode-announcement" role="status">
        {props.pendingTarget ? `Switching to ${label(props.pendingTarget === 'chat' ? choices[0] : choices[1])}` : ''}
      </span>
      <Show when={open()}>
        <Portal>
          <div class="header-user-dropdown-overlay" data-testid="workspace-mode-overlay"
            onClick={event => { if (event.target === event.currentTarget) close(); }}>
            <div ref={element => {
              popup = element;
              queueMicrotask(() => {
                if (element.isConnected) element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
              });
            }} class="header-user-dropdown header-user-dropdown--portal" data-workspace-mode-focus role="group" aria-label="Workspace mode options"
              style={window.innerWidth > 640 && position() ? { top: `${position()!.top}px`, right: `${position()!.right}px` } : undefined}
              onKeyDown={event => {
                if (event.key === 'Escape') { event.stopPropagation(); close(); }
              }} onFocusOut={event => {
                if (event.relatedTarget instanceof Node && !popup?.contains(event.relatedTarget) && !root?.contains(event.relatedTarget)) setOpen(false);
              }}>
              <For each={choices}>{choice => (
                <button type="button" class="header-user-dropdown-item header-workspace-mode-choice" aria-label={label(choice)}
                  aria-pressed={props.value === choice.value} disabled={props.disabled || !!props.pendingTarget} onClick={() => select(choice.value)}>
                  <span aria-hidden="true" class="workspace-mode-choice-label" data-label={label(choice)}>
                    <Show when={props.pendingTarget === choice.value} fallback={<span>{label(choice)}</span>}>
                      <ScrambleText text={label(choice)} skipInitialHold />
                    </Show>
                  </span>
                  <Show when={props.value === choice.value}>
                    <Icon path={mdiCheck} size={16} aria-hidden="true" />
                  </Show>
                </button>
              )}</For>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
