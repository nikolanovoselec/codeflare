SilverBullet theme tuned to match the Codeflare design system.

Targets SilverBullet 2.x's actual CSS variables (`--root-*`, `--ui-accent-*`, `--editor-*`, `--top-*`, `--button-*`, `--modal-*`, `--panel-*`, `--editor-wiki-link-*`) — verified against `client/styles/theme.scss` in the silverbullet 2.8.0 source. Earlier `--cf-*`-namespaced variables were unused by SB and had zero visual effect.

#meta/styles

```css
/* ===========================================================================
 * Codeflare palette (Tailwind zinc + blue-500 accent, matches
 * web-ui/src/styles/design-tokens.css).
 * =========================================================================*/

:root {
  --cf-bg-base:        #09090b; /* zinc-950 */
  --cf-bg-surface:     #18181b; /* zinc-900 */
  --cf-bg-tertiary:    #1f1f23;
  --cf-bg-elevated:    #27272a; /* zinc-800 */
  --cf-bg-muted:       #3f3f46; /* zinc-700 */
  --cf-border-subtle:  #27272a;
  --cf-border-default: #3f3f46;
  --cf-border-strong:  #52525b; /* zinc-600 */
  --cf-text-primary:   #fafafa; /* zinc-50  */
  --cf-text-secondary: #a1a1aa; /* zinc-400 */
  --cf-text-muted:     #71717a; /* zinc-500 */
  --cf-text-dimmed:    #52525b;
  --cf-accent:         hsl(217, 91%, 60%); /* blue-500 */
  --cf-accent-hover:   hsl(217, 91%, 53%);
  --cf-accent-muted:   hsla(217, 91%, 60%, 0.15);
  --cf-success:        #22c55e;
  --cf-warning:        #f59e0b;
  --cf-error:          #ef4444;
  --cf-font-sans:      'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --cf-font-mono:      'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
  --cf-radius-sm: 4px;
  --cf-radius-md: 6px;
  --cf-radius-lg: 8px;

  /* SilverBullet UI font (consumed in :root and all themes). */
  --ui-font: var(--cf-font-sans);
}

/* ===========================================================================
 * Dark theme override (SB defaults to dark in our preseed).
 * Same selector SB uses — document order wins because <div id="custom-styles">
 * is injected late in the DOM (client/client.ts:943).
 * =========================================================================*/

html[data-theme="dark"] {
  /* Root surfaces */
  --root-background-color:   var(--cf-bg-base);
  --root-color:              var(--cf-text-primary);

  /* Brand accent */
  --ui-accent-color:           var(--cf-accent);
  --ui-accent-contrast-color:  var(--cf-text-primary);
  --ui-accent-text-color:      var(--cf-accent);

  /* Top bar */
  --top-background-color:      var(--cf-bg-surface);
  --top-border-color:          var(--cf-border-subtle);
  --top-color:                 var(--cf-text-primary);
  --top-loading-color:         var(--cf-text-secondary);
  --top-saved-color:           var(--cf-text-primary);
  --top-unsaved-color:         var(--cf-text-secondary);
  --top-sync-error-background-color: hsla(0, 75%, 50%, 0.25);
  --top-sync-error-color:      var(--cf-error);

  /* Panels (sidebar, bottom) */
  --panel-background-color:    var(--cf-bg-surface);
  --panel-border-color:        var(--cf-border-subtle);

  /* Subtle / meta */
  --subtle-background-color:   rgba(255, 255, 255, 0.04);
  --subtle-color:              var(--cf-text-secondary);
  --meta-color:                var(--cf-text-secondary);
  --meta-subtle-color:         var(--cf-text-muted);

  /* Links */
  --link-color:                var(--cf-accent);
  --link-invalid-color:        var(--cf-error);
  --link-missing-color:        var(--cf-warning);
  --highlight-color:           var(--cf-accent-muted);

  /* Buttons */
  --button-background-color:   var(--cf-bg-elevated);
  --button-border-color:       var(--cf-border-default);
  --button-color:              var(--cf-text-primary);
  --button-hover-background-color: var(--cf-bg-muted);

  /* Action buttons (icon buttons in top bar) */
  --action-button-background-color: transparent;
  --action-button-color:            var(--cf-text-secondary);
  --action-button-hover-color:      var(--cf-accent);
  --action-button-active-color:     var(--cf-accent);

  /* Editor core */
  --editor-caret-color:        var(--cf-accent);
  --editor-selection-background-color: var(--cf-accent-muted);
  --editor-ruler-color:        var(--cf-border-subtle);

  /* Editor headings */
  --editor-heading-color:      var(--cf-text-primary);
  --editor-heading-meta-color: var(--cf-text-muted);

  /* Editor code (inline + fenced) */
  --editor-code-background-color: var(--cf-bg-surface);
  --editor-code-comment-color:    var(--cf-text-muted);
  --editor-code-info-color:       var(--cf-text-secondary);
  --editor-code-string-color:     #c4b5fd;       /* violet-300 */
  --editor-code-number-color:     #fda4af;       /* rose-300 */
  --editor-code-variable-color:   #93c5fd;       /* blue-300 */
  --editor-code-typename-color:   #86efac;       /* green-300 */
  --editor-code-atom-color:       #f9a8d4;       /* pink-300 */

  /* Editor blockquotes */
  --editor-blockquote-background-color: var(--cf-bg-surface);
  --editor-blockquote-border-color:     var(--cf-border-default);
  --editor-blockquote-color:            var(--cf-text-secondary);

  /* Editor widgets / directives / frontmatter */
  --editor-widget-background-color:      var(--cf-bg-elevated);
  --editor-directive-background-color:   rgba(255, 255, 255, 0.04);
  --editor-directive-color:              var(--cf-text-muted);
  --editor-directive-mark-color:         var(--cf-error);
  --editor-frontmatter-background-color: var(--cf-bg-surface);
  --editor-frontmatter-color:            var(--cf-text-secondary);
  --editor-frontmatter-marker-color:     var(--cf-text-primary);

  /* Editor hashtags */
  --editor-hashtag-background-color: var(--cf-accent-muted);
  --editor-hashtag-border-color:     hsla(217, 91%, 60%, 0.3);
  --editor-hashtag-color:            var(--cf-text-primary);

  /* Editor wiki links */
  --editor-wiki-link-color:               var(--cf-accent);
  --editor-wiki-link-page-color:          var(--cf-accent);
  --editor-wiki-link-page-background-color: var(--cf-accent-muted);
  --editor-wiki-link-page-invalid-color:  var(--cf-error);
  --editor-wiki-link-page-missing-color:  var(--cf-warning);

  /* Editor link styling */
  --editor-link-color:        var(--cf-accent);
  --editor-link-meta-color:   var(--cf-text-muted);
  --editor-link-url-color:    var(--cf-accent);
  --editor-naked-url-color:   var(--cf-accent);

  /* Editor lists / tasks */
  --editor-list-bullet-color: var(--cf-text-muted);
  --editor-task-marker-color: var(--cf-text-secondary);
  --editor-task-state-color:  var(--cf-text-secondary);

  /* Editor tables */
  --editor-table-even-background-color: rgba(255, 255, 255, 0.02);
  --editor-table-head-background-color: var(--cf-bg-elevated);
  --editor-table-head-color:            var(--cf-text-primary);

  /* Editor structure tokens (e.g. ``` fences, list markers as MarkN) */
  --editor-struct-color: var(--cf-accent);
  --editor-line-meta-color: var(--cf-text-muted);

  /* Editor command-buttons (used by widgets.commandButton on dashboard) */
  --editor-command-button-background-color:       var(--cf-bg-elevated);
  --editor-command-button-border-color:           var(--cf-border-default);
  --editor-command-button-color:                  var(--cf-text-primary);
  --editor-command-button-hover-background-color: var(--cf-bg-muted);
  --editor-command-button-meta-color:             var(--cf-text-muted);

  /* Editor bottom panels (status bar) */
  --editor-panels-bottom-background-color: var(--cf-bg-surface);
  --editor-panels-bottom-border-color:     var(--cf-border-subtle);
  --editor-panels-bottom-color:            var(--cf-text-secondary);
  --editor-panels-bottom-input-background-color: var(--cf-bg-elevated);

  /* Editor completion popup */
  --editor-completion-detail-color:          var(--cf-text-secondary);
  --editor-completion-detail-selected-color: var(--cf-text-primary);

  /* Modals (page picker, command palette) */
  --modal-background-color:                  var(--cf-bg-surface);
  --modal-border-color:                      var(--cf-border-default);
  --modal-color:                             var(--cf-text-primary);
  --modal-description-color:                 var(--cf-text-secondary);
  --modal-header-label-color:                var(--cf-accent);
  --modal-help-background-color:             var(--cf-bg-elevated);
  --modal-help-color:                        var(--cf-text-secondary);
  --modal-hint-background-color:             var(--cf-accent-muted);
  --modal-hint-color:                        var(--cf-text-primary);
  --modal-hint-inactive-background-color:    var(--cf-bg-elevated);
  --modal-hint-inactive-color:               var(--cf-text-muted);
  --modal-selected-option-background-color:  var(--cf-accent);
  --modal-selected-option-color:             var(--cf-text-primary);
  --modal-selected-option-description-color: rgba(255, 255, 255, 0.9);

  /* Notifications (toasts) */
  --notifications-background-color:          var(--cf-bg-elevated);
  --notifications-border-color:              var(--cf-border-default);
  --notification-info-background-color:      hsla(217, 91%, 60%, 0.25);
  --notification-warning-background-color:   hsla(38, 92%, 50%, 0.25);
  --notification-error-background-color:     hsla(0, 75%, 50%, 0.25);

  /* Progress indicators */
  --progress-background-color: var(--cf-bg-elevated);
  --progress-index-color:      var(--cf-warning);
  --progress-sync-color:       var(--cf-accent);

  /* Bottom hidden state (mobile) */
  --bhs-background-color: var(--cf-bg-surface);
  --bhs-border-color:     var(--cf-border-default);

  /* Text fields */
  --text-field-background-color: var(--cf-bg-elevated);
}

/* ===========================================================================
 * Typography polish that isn't var-driven in SB.
 * =========================================================================*/

.cm-content {
  font-family: var(--cf-font-sans);
  font-size: 14px;
  line-height: 1.65;
  padding: 1.5rem 2rem;
  max-width: 860px;
  margin: 0 auto;
}

.cm-line code,
.sb-line-fenced-code,
pre code {
  font-family: var(--cf-font-mono);
  font-size: 0.88em;
}

/* Heading hierarchy (SB's defaults render too uniform). */
.sb-line-h1 { font-size: 1.8rem;  font-weight: 700; margin-top: 1.6em; padding-bottom: 0.25em; border-bottom: 1px solid var(--cf-border-subtle); }
.sb-line-h2 { font-size: 1.45rem; font-weight: 700; margin-top: 1.4em; }
.sb-line-h3 { font-size: 1.15rem; font-weight: 600; margin-top: 1.2em; }
.sb-line-h4,
.sb-line-h5,
.sb-line-h6 { font-weight: 600; }

/* Scrollbars */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: var(--cf-bg-base); }
::-webkit-scrollbar-thumb { background: var(--cf-border-default); border-radius: var(--cf-radius-sm); }
::-webkit-scrollbar-thumb:hover { background: var(--cf-border-strong); }

/* Selection */
::selection { background: var(--cf-accent-muted); }

/* Checkbox accent (task lists) */
input[type="checkbox"] { accent-color: var(--cf-accent); }
```
