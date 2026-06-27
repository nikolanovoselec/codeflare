import { Component, Show, type JSX } from 'solid-js';

interface SetupSectionProps {
  title: string;
  description?: JSX.Element;
  children: JSX.Element;
}

/**
 * A titled group of related setup fields — the "labelled section of fields" the
 * enterprise Configure step repeats (Access & Identity, AI Gateway, Browser Rendering,
 * Security & Egress, …). Pages compose these instead of dumping every field flat, so an
 * admin scans the wizard by concern. Pure structure: it carries no copy or field logic,
 * only the section chrome (`.setup-section` / `-header` / `-title` / `-description` /
 * `-body`); the fields it wraps are passed as children and keep their own bindings.
 */
const SetupSection: Component<SetupSectionProps> = (props) => {
  return (
    <section class="setup-section">
      <div class="setup-section-header">
        <h3 class="setup-section-title">{props.title}</h3>
        <Show when={props.description}>
          <p class="setup-section-description">{props.description}</p>
        </Show>
      </div>
      <div class="setup-section-body">{props.children}</div>
    </section>
  );
};

export default SetupSection;
