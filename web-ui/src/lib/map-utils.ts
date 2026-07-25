/**
 * Remove all entries from a Map whose keys start with `prefix`, optionally
 * calling `teardown` on each value before deletion (L14: extracted helper).
 */
export function cleanupMapByPrefix<T>(map: Map<string, T>, prefix: string, teardown?: (value: T) => void): void {
  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) {
      if (teardown) {
        teardown(map.get(key)!);
      }
      map.delete(key);
    }
  }
}
