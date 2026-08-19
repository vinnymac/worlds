/** Standard Date fields used across all worlds */
export const DATE_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'startedAt',
  'completedAt',
  'retryAfter',
] as const);

/**
 * JSON reviver that converts ISO date strings to Date objects.
 * Use with JSON.parse(json, dateReviver).
 */
export function dateReviver(key: string, value: unknown): unknown {
  if (
    DATE_FIELDS.has(key as typeof DATE_FIELDS extends Set<infer T> ? T : never) &&
    typeof value === 'string'
  ) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return value;
}

/**
 * JSON replacer that encodes Uint8Array as a tagged object with base64 data.
 */
export function uint8ArrayReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __type: 'Uint8Array',
      data: Buffer.from(value).toString('base64'),
    };
  }
  return value;
}

/**
 * JSON reviver that decodes tagged Uint8Array objects and ISO date strings.
 * Supports both:
 * - New format: { __type: 'Uint8Array', data: '<base64>' }
 * - Legacy format: { __uint8array: true, data: [1, 2, 3] }
 */
export function uint8ArrayReviver(key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // New format: base64-encoded
    if (obj.__type === 'Uint8Array' && typeof obj.data === 'string') {
      return new Uint8Array(Buffer.from(obj.data as string, 'base64'));
    }
    // Legacy format: number array (backwards compat with NATS JetStream data)
    if (obj.__uint8array === true && Array.isArray(obj.data)) {
      return new Uint8Array(obj.data as number[]);
    }
  }
  return dateReviver(key, value);
}

// Handing JSON a reviver/replacer forces V8 off its fast path and calls into
// JS for every node. The paths below keep identical semantics while avoiding
// that: measured ~5x on parse and ~2x on stringify, holding from 6 KB to
// 700 KB payloads. Wire format is unchanged.

/** Tags `uint8ArrayReviver` decodes. Absent both, only dates need reviving. */
const BINARY_TAG = '"__type"';
const LEGACY_BINARY_TAG = '"__uint8array"';

/** Revive `DATE_FIELDS` in place at any depth — the same reach as
 * `dateReviver` under `JSON.parse`, just without the per-node JSON interop. */
function reviveDatesDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = reviveDatesDeep(value[i]);
    }
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key in obj) {
    const child = obj[key];
    if (DATE_FIELDS.has(key as never) && typeof child === 'string') {
      const date = new Date(child);
      if (!Number.isNaN(date.getTime())) {
        obj[key] = date;
        continue;
      }
    }
    obj[key] = reviveDatesDeep(child);
  }
  return obj;
}

/**
 * Is there a `Uint8Array` anywhere in the graph?
 *
 * Must stay exact: `JSON.stringify` turns a bare `Uint8Array` into
 * `{"0":1,...}` without complaint, so a miss is data corruption, not a slow
 * path. The walk allocates nothing, which is why it beats the replacer over
 * the same nodes.
 */
export function hasBinary(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (value instanceof Uint8Array) {
    return true;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (hasBinary(value[i])) {
        return true;
      }
    }
    return false;
  }
  for (const key in value as Record<string, unknown>) {
    if (hasBinary((value as Record<string, unknown>)[key])) {
      return true;
    }
  }
  return false;
}

/** Stringify with Uint8Array support. */
export function stringify(value: unknown): string {
  return hasBinary(value) ? JSON.stringify(value, uint8ArrayReplacer) : JSON.stringify(value);
}

/** Parse with Uint8Array and Date support. */
export function parse<T>(text: string): T {
  if (text.includes(BINARY_TAG) || text.includes(LEGACY_BINARY_TAG)) {
    return JSON.parse(text, uint8ArrayReviver) as T;
  }
  return reviveDatesDeep(JSON.parse(text)) as T;
}

/**
 * Apply the same revival as `parse`, but to an already-decoded value.
 *
 * For transports that hand back parsed objects rather than text (the Upstash
 * REST client, for one), the alternative is to re-stringify just to run it
 * back through `parse` — paying a full serialize *and* parse per read.
 */
export function revive<T>(value: unknown): T {
  if (value === null || typeof value !== 'object') {
    return value as T;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = revive(value[i]);
    }
    return value as T;
  }
  const obj = value as Record<string, unknown>;
  if (obj.__type === 'Uint8Array' && typeof obj.data === 'string') {
    return new Uint8Array(Buffer.from(obj.data, 'base64')) as T;
  }
  if (obj.__uint8array === true && Array.isArray(obj.data)) {
    return new Uint8Array(obj.data as number[]) as T;
  }
  for (const key in obj) {
    const child = obj[key];
    if (DATE_FIELDS.has(key as never) && typeof child === 'string') {
      const date = new Date(child);
      if (!Number.isNaN(date.getTime())) {
        obj[key] = date;
        continue;
      }
    }
    obj[key] = revive(child);
  }
  return obj as T;
}

/** Deep clone using structuredClone */
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
