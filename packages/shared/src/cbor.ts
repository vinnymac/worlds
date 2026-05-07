import { decode, encode } from 'cbor-x';

/**
 * Encode any value as CBOR bytes.
 */
export function encodeCbor(value: unknown): Buffer {
  if (value === undefined || value === null) {
    return encode(null);
  }
  return encode(value);
}

/**
 * Decode CBOR bytes to a value.
 */
export function decodeCbor<T>(bytes: Uint8Array | Buffer): T {
  return decode(bytes) as T;
}

/**
 * Type helper for CBOR-migrated columns.
 * Adds a `{key}Json` property representing the previous JSONB representation.
 */
export type Cborized<V extends object, K extends keyof V> = V & {
  [key in `${Extract<K, string>}Json`]: unknown;
};
