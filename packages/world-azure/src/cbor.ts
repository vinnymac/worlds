import { decode, encode } from 'cbor-x';

/**
 * Recursively reconstruct Buffer objects from Cosmos DB JSON representation.
 * Cosmos DB stores Buffers as { type: "Buffer", data: [1,2,3...] } or as plain objects with numeric keys.
 */
function reconstructBuffers(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle explicit Buffer JSON format: { type: "Buffer", data: [...] }
  if (
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'Buffer' &&
    'data' in value &&
    Array.isArray(value.data)
  ) {
    return Buffer.from(value.data);
  }

  // Handle numeric-keyed object that looks like a Uint8Array: { "0": 100, "1": 101, ... }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const isNumericSequence = keys.every((k, i) => k === String(i));
    if (isNumericSequence && keys.length > 0) {
      // Check if all values are numbers in byte range (0-255)
      const values = Object.values(value);
      if (values.every((v) => typeof v === 'number' && v >= 0 && v <= 255)) {
        return new Uint8Array(values as number[]);
      }
    }

    // Recursively process object properties
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = reconstructBuffers(val);
    }
    return result;
  }

  // Recursively process arrays
  if (Array.isArray(value)) {
    return value.map(reconstructBuffers);
  }

  return value;
}

/**
 * Encode a value to CBOR format (Concise Binary Object Representation).
 * Used to serialize workflow input/output data before storing in Cosmos DB.
 *
 * CBOR properly handles:
 * - Uint8Array and Buffer objects
 * - Date objects
 * - Nested structures
 * - Binary data
 *
 * @param value - The value to encode
 * @returns Encoded data as Uint8Array
 */
export function encodeCbor(value: unknown): Uint8Array {
  if (value === undefined || value === null) {
    return encode(null);
  }
  return encode(value);
}

/**
 * Decode CBOR-encoded data back to its original form.
 * Used when reading workflow input/output data from Cosmos DB.
 *
 * @param buffer - The CBOR-encoded data
 * @returns Decoded value
 */
export function decodeCbor(buffer: unknown): unknown {
  if (buffer === undefined || buffer === null) {
    return undefined;
  }

  // Reconstruct any Buffers that were JSON-serialized by Cosmos DB
  buffer = reconstructBuffers(buffer);

  // Handle case where data might already be decoded (for backwards compatibility)
  if (!(buffer instanceof Uint8Array) && !Buffer.isBuffer(buffer)) {
    return buffer;
  }

  return decode(buffer as Uint8Array);
}
