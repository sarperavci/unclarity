// Force-set a property even when the target only exposes a getter (common in jsdom). Returns whether
// the value took. Best-effort: a non-configurable accessor can't be overridden, and rather than
// aborting realm setup we report false so callers can decide (most shims are non-fatal).
export function force<T extends object>(obj: T, key: PropertyKey, value: unknown): boolean {
  try {
    (obj as Record<PropertyKey, unknown>)[key] = value;
    if ((obj as Record<PropertyKey, unknown>)[key] === value) return true;
  } catch {
    /* fall through to defineProperty */
  }
  try {
    Object.defineProperty(obj, key, { value, configurable: true, writable: true });
    return true;
  } catch {
    return false; // non-configurable target — leave as-is
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
