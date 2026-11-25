import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { mdiChevronDown, mdiFormDropdown } from '@mdi/js';
import { Portal } from 'solid-js/web';
import type { PiSurface } from '../types';
import Icon from './Icon';
import { createTerminalViewportClass } from '../lib/mobile';
import '../styles/header.css';
import '../styles/settings-panel.css';

const choices = [
  { value: 'chat', name: 'Vibe', surface: 'Chat' },
  { value: 'terminal', name: 'Code', surface: 'Terminal' },
] as const;

type Choice = typeof choices[number];
const label = (choice: Choice) => `${choice.name} — ${choice.surface}`;

export interface PiWorkspaceModeBinding {
  value: PiSurface;
  disabled?: boolean;
  onSelect: (value: PiSurface) => void;
}

export default function PiWorkspaceMode(props: PiWorkspaceModeBinding & { presentation?: 'segments' | 'text' | 'icon'; fitContainer?: boolean }) {
  const viewport = createTerminalViewportClass();
  const preferred = () => props.presentation ?? (viewport() === 'desktop' ? 'segments' : viewport() === 'tablet' ? 'text' : 'icon');
  const [compact, setCompact] = createSignal(false);
  const presentation = () => compact() ? 'icon' : preferred();
  const [open, setOpen] = createSignal(false);
  const current = () => props.value === 'chat' ? choices[0] : choices[1];
  let root: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let popup: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<{ top: number; right: number }>();

  onMount(() => {
    const header = root?.parentElement;
    if (!props.fitContainer || !header || !root || typeof ResizeObserver === 'undefined') return;
    const slot = root;
    const widths: Partial<Record<'segments' | 'text', number>> = {};
    const measure = () => {
      const variant = preferred();
      if (!header.clientWidth || variant === 'icon') { setCompact(false); return; }
      if (presentation() === variant) widths[variant] = slot.scrollWidth || widths[variant];
      const style = getComputedStyle(header);
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      const gap = pixels(style.columnGap);
      const sides = [0, 0];
      let side = 0;
      for (const child of header.children) {
        if (child === slot) { side = 1; continue; }
        if (!child.classList.contains('header-spacer')) sides[side] += Math.max(child.getBoundingClientRect().width, child.scrollWidth) + gap;
      }
      const room = header.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
      const available = room - (variant === 'segments' ? 2 * Math.max(...sides) : sides[0] + sides[1]);
      setCompact(widths[variant] !== undefined && available < widths[variant]);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(slot);
    for (const child of header.children) observer.observe(child);
    measure();
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (open() && (props.disabled || presentation() === 'segments')) setOpen(false);
  });

  const close = () => {
    setOpen(false);
    trigger?.focus();
  };
  const toggle = () => {
    if (open()) { close(); return; }
    const rect = trigger?.getBoundingClientRect();
    setPosition(rect ? { top: rect.bottom + 8, right: Math.max(0, window.innerWidth - rect.right) } : undefined);
    setOpen(true);
  };
  const select = (value: PiSurface) => {
    if (open()) close();
    if (value !== props.value) props.onSelect(value);
  };

  return (
    <div class="session-switcher-wrapper" data-header-center={presentation() === 'segments' ? 'centered' : 'compact'} ref={root}>
      <Show when={presentation() === 'segments'} fallback={<>
        <button ref={trigger} type="button"
          classList={{ 'session-switcher': true, 'session-switcher--mobile': presentation() === 'icon' }}
          aria-label={`Workspace mode: ${label(current())}`} aria-expanded={open()}
          disabled={props.disabled} onClick={toggle}
          onKeyDown={event => { if (event.key === 'Escape' && open()) { event.stopPropagation(); close(); } }}>
          <Show when={presentation() === 'text'} fallback={<Icon path={mdiFormDropdown} size={22} aria-hidden="true" />}>
            <span>{current().name} · {current().surface}</span><Icon path={mdiChevronDown} size={18} aria-hidden="true" />
          </Show>
        </button>
        <Show when={open()}>
          <Portal>
            <div class="header-user-dropdown-overlay" data-testid="workspace-mode-overlay"
              onClick={event => { if (event.target === event.currentTarget) close(); }}>
              <div ref={element => {
                popup = element;
                queueMicrotask(() => {
                  if (element.isConnected) element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
                });
              }} class="header-user-dropdown header-user-dropdown--portal" role="group" aria-label="Workspace mode options"
                style={window.innerWidth > 640 && position() ? { top: `${position()!.top}px`, right: `${position()!.right}px` } : undefined}
                onKeyDown={event => {
                  if (event.key === 'Escape') { event.stopPropagation(); close(); }
                }} onFocusOut={event => {
                  if (event.relatedTarget instanceof Node && !popup?.contains(event.relatedTarget) && !root?.contains(event.relatedTarget)) setOpen(false);
                }}>
                <For each={choices}>{choice => (
                  <button type="button" class="header-user-dropdown-item" aria-label={label(choice)}
                    aria-pressed={props.value === choice.value} disabled={props.disabled} onClick={() => select(choice.value)}>
                    <span>{choice.name}</span><span class="type-hint">{choice.surface}</span>
                  </button>
                )}</For>
              </div>
            </div>
          </Portal>
        </Show>
      </>}>
      <div class="session-mode-control" role="group" aria-label="Workspace mode">
        <For each={choices}>{choice => (
          <button type="button" class="session-mode-option" aria-label={label(choice)}
            classList={{ 'session-mode-option--selected': props.value === choice.value, 'session-mode-option--disabled': props.disabled }}
            aria-pressed={props.value === choice.value} disabled={props.disabled} onClick={() => select(choice.value)}>
            <span>{choice.name}<br /><small>{choice.surface}</small></span>
          </button>
        )}</For>
      </div>
      </Show>
    </div>
  );
}
