import { createDebugLogger, stringify } from '@fantasticfour/shared';

export { compact, Mutex, Rc } from '@fantasticfour/shared';
export { parse, stringify } from '@fantasticfour/shared';
export const debug = createDebugLogger('redis-world');

/**
 * JSON reviver function that converts tagged marker objects back to
 * Uint8Array. Accepts both encodings:
 * - Current: `{ __type: 'Uint8Array', data: '<base64>' }` (shared helper)
 * - Legacy:  `{ __uint8array: true, data: [1, 2, 3] }` (data already in Redis)
 *
 * NOTE: dates are intentionally NOT revived here — this is why world-redis
 * keeps its own reviver instead of using the shared `parse`. Persisted
 * entities are always run through their zod schemas (which coerce ISO strings
 * to Dates) before being returned, so a blanket date reviver would only serve
 * to corrupt user data that happens to use keys like `createdAt` at arbitrary
 * nesting depths.
 */
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

/**
 * Stringify an object with Uint8Array support.
 *
 * Delegates to the shared helper, which tags binary payloads as base64
 * (`{ __type: 'Uint8Array', data: '<base64>' }`). The previous local encoding
 * emitted a JSON array of numbers, which cost ~450x more CPU to re-parse and
 * ~2.7x more storage at a 2MB payload.
 */
export function stringifyWithUint8Array(obj: unknown): string {
  return stringify(obj);
}

/**
 * Parse JSON with Uint8Array support.
 */
export function parseWithUint8Array<T>(json: string): T {
  return JSON.parse(json, uint8ArrayReviver) as T;
}
