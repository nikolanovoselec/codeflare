# Gestures and input

Read this for pointer, touch, keyboard, direct manipulation, comparison controls, or hold interactions.

## Define the interaction contract

Specify start conditions, active pointer or touch ownership, movement bounds, thresholds, velocity use, cancellation, release, final state, and behavior when another input interrupts. Use pointer capture or the platform equivalent when interaction must continue outside the original target. Handle multi-touch deliberately rather than treating every contact as the same drag.

Gate hover effects on actual hover capability. Preserve keyboard and assistive-technology access. Gesture dismissal needs a visible non-gesture alternative.

## Keep direct manipulation direct

During dragging, scrubbing, resizing, or reordering, visual response should track input without decorative lag. Springs may settle after release; they should not make the controlled object feel detached during manipulation unless that behavior is the product concept.

Comparison sliders need an operable range control, accessible name/value, keyboard behavior, and touch target. Hold-to-confirm or hold-to-delete needs explicit progress, cancellation, completion, keyboard access, and reduced-motion behavior; CSS active state alone is not a contract.

## Protect behavior

Prevent scroll or text selection only where the active gesture requires it and restore normal behavior afterward. Clean up capture, listeners, observers, timers, and animation state on cancel, unmount, navigation, or visibility change.

Test pointer, touch, keyboard, cancellation, rapid reversal, lost capture, multi-touch, scroll conflict, orientation or window changes, and assistive technology where capabilities exist.
