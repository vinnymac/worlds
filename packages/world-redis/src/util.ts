import { createDebugLogger } from '@fantasticfour/shared';

export { compact, Mutex, Rc } from '@fantasticfour/shared';
export { parse, stringify } from '@fantasticfour/shared';
export const debug = createDebugLogger('redis-world');

/**
 * JSON replacer function that converts Uint8Array to a special marker object.
 * This ensures Uint8Array fields are preserved through JSON.stringify/parse.
 *
 * Handles any field that contains a Uint8Array, including nested fields like
 * eventData.result (step_completed), eventData.output (run_completed),
 * and top-level fields like input, output, executionContext.
 *
 * NOTE: dates are intentionally NOT revived here. Persisted entities are
 * always run through their zod schemas (which coerce ISO strings to Dates)
 * before being returned, so a blanket date reviver would only serve to
 * corrupt user data that happens to use keys like `createdAt` at arbitrary
 * nesting depths.
 */
function uint8ArrayReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __uint8array: true,
      data: Array.from(value),
    };
  }
  return value;
}

/**
 * JSON reviver function that converts marker objects back to Uint8Array.
 */
function uint8ArrayReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    (value as { __uint8array?: unknown }).__uint8array === true &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return new Uint8Array((value as { data: number[] }).data);
  }
  return value;
}

/**
 * Stringify an object with Uint8Array support.
 */
export function stringifyWithUint8Array(obj: unknown): string {
  return JSON.stringify(obj, uint8ArrayReplacer);
}

/**
 * Parse JSON with Uint8Array support.
 */
export function parseWithUint8Array<T>(json: string): T {
  return JSON.parse(json, uint8ArrayReviver) as T;
}
