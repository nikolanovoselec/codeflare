/**
 * Client-side store for plugin-emitted intent broadcasts.
 *
 * The server's plugin runtime emits `plugin_intents` messages over the
 * WebSocket bridge. The client's `useMessageHandler` writes each message
 * into this store via `intentStore.set(...)`. Slot consumers subscribe
 * via `useSlotIntents(slot, sessionId)` and render via `IntentRenderer`.
 *
 * See change: adopt-server-driven-intent-rendering.
 */
import { useSyncExternalStore } from "react";
import type { IntentNode } from "@blackbelt-technology/pi-dashboard-shared/dashboard-plugin/intent-types.js";
import type { SlotId } from "@blackbelt-technology/pi-dashboard-shared/dashboard-plugin/slot-types.js";

export interface IntentKey {
  pluginId: string;
  sessionId: string | null;
  slot: SlotId;
}

export function keyToString(key: IntentKey): string {
  return `${key.pluginId}|${key.sessionId ?? ""}|${key.slot}`;
}

export interface IntentStoreEntry {
  pluginId: string;
  sessionId: string | null;
  slot: SlotId;
  intent: IntentNode;
}

/**
 * In-memory store of latest intent per (pluginId, sessionId, slot).
 *
 * Subscribers are notified on every mutation. `getForSlot` returns
 * Map<pluginId, IntentNode> for one (slot, sessionId) tuple, which slot
 * consumers iterate to render every contributing plugin's intent.
 */
export class IntentStore {
  private map = new Map<string, IntentStoreEntry>();
  private subscribers = new Set<() => void>();
  /**
   * Memoized snapshot per (slot, sessionId) key. Same identity is returned
   * on repeated calls between mutations so `useSyncExternalStore` doesn't
   * cause spurious re-renders.
   */
  private slotSnapshots = new Map<string, Map<string, IntentNode>>();

  set(key: IntentKey, intent: IntentNode | null): void {
    const k = keyToString(key);
    if (intent === null) {
      if (!this.map.has(k)) return;
      this.map.delete(k);
    } else {
      this.map.set(k, { ...key, intent });
    }
    // Invalidate slot snapshots: changing a single key invalidates the
    // snapshot for (slot, sessionId). Clearing the whole cache is cheap
    // because it's rebuilt lazily on next getForSlot call.
    this.slotSnapshots.clear();
    this.notify();
  }

  /**
   * Return Map<pluginId, IntentNode> for one slot at one session. Reference
   * stability: between mutations, the same Map instance is returned.
   */
  getForSlot(slot: SlotId, sessionId: string | null): Map<string, IntentNode> {
    const snapKey = `${slot}|${sessionId ?? ""}`;
    const cached = this.slotSnapshots.get(snapKey);
    if (cached) return cached;

    const out = new Map<string, IntentNode>();
    for (const entry of this.map.values()) {
      if (entry.slot === slot && entry.sessionId === sessionId) {
        out.set(entry.pluginId, entry.intent);
      }
    }
    this.slotSnapshots.set(snapKey, out);
    return out;
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  clearForSession(sessionId: string | null): void {
    let changed = false;
    for (const [k, entry] of this.map) {
      if (entry.sessionId === sessionId) {
        this.map.delete(k);
        changed = true;
      }
    }
    if (changed) {
      this.slotSnapshots.clear();
      this.notify();
    }
  }

  /** Test-only: reset state. */
  __resetForTests(): void {
    this.map.clear();
    this.slotSnapshots.clear();
    this.subscribers.clear();
  }

  private notify(): void {
    for (const cb of this.subscribers) cb();
  }
}

/** Module-level singleton — every client consumer shares the same store. */
export const intentStore = new IntentStore();

/**
 * Empty fallback returned when no intents exist for a slot+session. Stable
 * identity to play nicely with useSyncExternalStore.
 */
const EMPTY_SLOT: ReadonlyMap<string, IntentNode> = new Map();

/**
 * React hook: subscribe to the IntentStore and return all intents currently
 * cached for (slot, sessionId). Returns Map<pluginId, IntentNode>.
 *
 * Reference stability: returns the same Map instance between store mutations
 * so consuming components don't re-render when unrelated state changes.
 */
export function useSlotIntents(
  slot: SlotId,
  sessionId: string | null,
): ReadonlyMap<string, IntentNode> {
  return useSyncExternalStore(
    (cb) => intentStore.subscribe(cb),
    () => {
      const result = intentStore.getForSlot(slot, sessionId);
      return result.size > 0 ? result : EMPTY_SLOT;
    },
    () => EMPTY_SLOT,
  );
}
