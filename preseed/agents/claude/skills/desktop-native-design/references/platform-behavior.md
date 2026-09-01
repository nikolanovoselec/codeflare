# Desktop platform behavior

Read this when windows, commands, files, system integration, adaptation, lifecycle, or accessibility affects the result.

## Establish the support contract

Record target operating systems and versions, incumbent framework, minimum and expected window sizes, multiple-window or document model, high-DPI and multi-monitor needs, keyboard/pointer/touch/pen inputs, accessibility commitments, localization, offline behavior, and permitted platform divergence. Check current primary platform and framework documentation for version-sensitive behavior.

## Windows and lifecycle

Design resizing, minimum size, maximization, full screen, restoration, display changes, and background behavior deliberately. Support multiple windows, tabs, palettes, inspectors, or documents only when the job requires them. Preserve user position, selection, unsaved work, and safe recovery after interruption, update, crash, or restart.

For document work, define open, create, save, autosave, export, recent items, external change, conflict, close, destructive confirmation, and recovery behavior. For non-document tools, define equivalent workspace and state restoration.

## Commands and input

Make frequent actions efficient and consequential actions clear. Use menus, toolbars, context menus, command palettes, shortcuts, accelerators, status areas, and tray or menu-bar integration where appropriate to the platform and product.

Provide complete keyboard operation, visible focus, logical traversal, selection behavior, and shortcut discoverability. Support pointer precision, hover where available, right-click or equivalent context action, drag/drop with an operable alternative, and touch or pen only when the target supports them. Never hide essential behavior behind gesture or hover alone.

## Adapt identity without cloning platforms

Keep product voice, content strategy, color logic, imagery, material intent, and signature recognizable. Let window chrome, command placement, controls, shortcuts, notifications, permissions, updates, and system integration follow target expectations. Pixel parity across operating systems is not the goal.

Electron and other web-rendered desktop stacks still require desktop window, command, keyboard, file, and system behavior. A browser shell is not an excuse to route the product as responsive web.

## Accessibility and adaptation

Cover platform accessibility APIs and screen readers, keyboard-only use, reduced motion, high contrast, text scaling, localization, bidirectional text, high DPI, multiple displays, and system themes where required. Verify focus and announcements across windows, dialogs, menus, popovers, notifications, and long-running actions.

Validate representative dense and narrow windows, long localized content, display-scale changes, restored sessions, permission denial, offline operation, failed updates or actions, and destructive recovery. Report missing platform evidence plainly.
