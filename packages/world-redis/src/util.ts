import { createDebugLogger, stringify } from '@fantasticfour/shared';

export { compact, Mutex, Rc } from '@fantasticfour/shared';
export { parse, stringify } from '@fantasticfour/shared';
export const debug = createDebugLogger('redis-world');

/** JSON reviver converting tagged markers back to Uint8Array; accepts the
 * current base64 tag and the legacy number-array tag. Dates are deliberately
 * not revived; zod schemas coerce them, and a blanket reviver corrupts data. */
function uint8ArrayReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const marker = value as { __type?: unknown; __uint8array?: unknown; data?: unknown };
    if (marker.__type === 'Uint8Array' && typeof marker.data === 'string') {
      return new Uint8Array(Buffer.from(marker.data, 'base64'));
    }
    if (marker.__uint8array === true && Array.isArray(marker.data)) {
      return new Uint8Array(marker.data as number[]);
    }
  }
  return value;
}

/** Stringify an object with Uint8Array support. Delegates to the shared
 * helper, which tags binary as base64; the previous number-array encoding
 * cost ~450x more CPU to re-parse and ~2.7x more storage at 2MB. */
export function stringifyWithUint8Array(obj: unknown): string {
  return stringify(obj);
}

/**
 * Parse JSON with Uint8Array support.
 */
export function parseWithUint8Array<T>(json: string): T {
  return JSON.parse(json, uint8ArrayReviver) as T;
}
