SilverBullet theme tuned to match the codeflare design system.

#meta/styles

```css
:root {
  --cf-bg-base: #09090b;
  --cf-bg-surface: #18181b;
  --cf-bg-tertiary: #1f1f23;
  --cf-bg-elevated: #27272a;
  --cf-bg-muted: #3f3f46;
  --cf-border-subtle: #27272a;
  --cf-border-default: #3f3f46;
  --cf-border-strong: #52525b;
  --cf-text-primary: #fafafa;
  --cf-text-secondary: #a1a1aa;
  --cf-text-muted: #71717a;
  --cf-text-dimmed: #52525b;
  --cf-accent: hsl(217, 91%, 60%);
  --cf-accent-hover: hsl(217, 91%, 53%);
  --cf-accent-muted: hsla(217, 91%, 60%, 0.15);
  --cf-success: #22c55e;
  --cf-warning: #f59e0b;
  --cf-error: #ef4444;
  --cf-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --cf-font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
  --cf-radius-sm: 4px;
  --cf-radius-md: 6px;
  --cf-radius-lg: 8px;
}

html, body {
  background: var(--cf-bg-base);
  color: var(--cf-text-primary);
  font-family: var(--cf-font-sans);
  font-size: 14px;
  line-height: 1.6;
}

#sb-root, #sb-main, .sb-panel, .cm-editor, .cm-scroller {
  background: var(--cf-bg-base);
  color: var(--cf-text-primary);
  font-family: var(--cf-font-sans);
}

.cm-content {
  font-family: var(--cf-font-sans);
  caret-color: var(--cf-accent);
  padding: 1.5rem 2rem;
  max-width: 820px;
  margin: 0 auto;
}

.sb-top {
  background: var(--cf-bg-surface);
  border-bottom: 1px solid var(--cf-border-subtle);
}

.sb-top .sb-current-page {
  color: var(--cf-text-primary);
  font-weight: 600;
}

.sb-line-h1 {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--cf-text-primary);
  border-bottom: 1px solid var(--cf-border-subtle);
  padding-bottom: 0.3em;
  margin-top: 1.5em;
}

.sb-line-h2 {
  font-size: 1.35rem;
  font-weight: 600;
  color: var(--cf-text-primary);
  margin-top: 1.4em;
}

.sb-line-h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--cf-text-primary);
  margin-top: 1.2em;
}

.sb-line-h4, .sb-line-h5, .sb-line-h6 {
  font-weight: 600;
  color: var(--cf-text-secondary);
}

.sb-wiki-link-page,
.cm-link {
  color: var(--cf-accent);
  text-decoration: none;
}

.sb-wiki-link-page:hover,
.cm-link:hover {
  color: var(--cf-accent-hover);
  text-decoration: underline;
}

.sb-wiki-link-page-missing {
  color: var(--cf-error);
  text-decoration: underline dotted;
}

.sb-line-code,
.sb-line-fenced-code,
.cm-line code,
code {
  font-family: var(--cf-font-mono);
  font-size: 0.85em;
  background: var(--cf-bg-elevated);
  color: var(--cf-text-primary);
  padding: 0.1em 0.4em;
  border-radius: var(--cf-radius-sm);
  border: 1px solid var(--cf-border-subtle);
}

.sb-line-fenced-code,
.cm-line.cm-line-code {
  background: var(--cf-bg-surface);
  border-left: 3px solid var(--cf-accent);
  padding-left: 1rem;
}

pre, .cm-line-code-fenced {
  background: var(--cf-bg-surface);
  border: 1px solid var(--cf-border-subtle);
  border-radius: var(--cf-radius-md);
}

blockquote,
.sb-line-blockquote {
  border-left: 3px solid var(--cf-border-strong);
  color: var(--cf-text-secondary);
  padding-left: 1rem;
  margin-left: 0;
}

hr {
  border: none;
  border-top: 1px solid var(--cf-border-subtle);
  margin: 2em 0;
}

.sb-line-task-state,
input[type="checkbox"] {
  accent-color: var(--cf-accent);
}

table {
  border-collapse: collapse;
  margin: 1em 0;
}

th, td {
  border: 1px solid var(--cf-border-subtle);
  padding: 0.5em 0.8em;
}

th {
  background: var(--cf-bg-surface);
  color: var(--cf-text-primary);
  font-weight: 600;
}

::selection {
  background: var(--cf-accent-muted);
}

::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: var(--cf-bg-base);
}

::-webkit-scrollbar-thumb {
  background: var(--cf-border-default);
  border-radius: var(--cf-radius-sm);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--cf-border-strong);
}

.sb-button, button.sb-button {
  background: var(--cf-bg-elevated);
  color: var(--cf-text-primary);
  border: 1px solid var(--cf-border-subtle);
  border-radius: var(--cf-radius-md);
  padding: 0.4em 0.9em;
  font-family: var(--cf-font-sans);
  font-weight: 500;
  cursor: pointer;
  transition: background 150ms ease-out, border-color 150ms ease-out;
}

.sb-button:hover {
  background: var(--cf-bg-muted);
  border-color: var(--cf-border-default);
}

.sb-modal, .sb-filter-box, .sb-panel-header {
  background: var(--cf-bg-elevated);
  border: 1px solid var(--cf-border-subtle);
  color: var(--cf-text-primary);
}
```
