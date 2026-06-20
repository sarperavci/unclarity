// Force-set a property even when the target only exposes a getter (common in jsdom).
export function force<T extends object>(obj: T, key: PropertyKey, value: unknown): void {
  try {
    (obj as Record<PropertyKey, unknown>)[key] = value;
    if ((obj as Record<PropertyKey, unknown>)[key] === value) return;
  } catch {
    /* fall through to defineProperty */
  }
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
