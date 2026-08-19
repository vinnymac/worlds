import { describe, expect, it } from 'vitest';
import { decodeCbor, encodeCbor } from '../src/cbor.js';

describe('CBOR serialization', () => {
  it('decodes encoded bytes directly', () => {
    const value = {
      text: 'x'.repeat(512_000),
      bytes: new Uint8Array([1, 2, 3, 255]),
    };

    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it('decodes the Cosmos Buffer representation', () => {
    const value = { nested: [['a'], ['b']], count: 3 };
    const encoded = encodeCbor(value);
    const serialized = JSON.parse(JSON.stringify(Buffer.from(encoded)));

    expect(decodeCbor(serialized)).toEqual(value);
  });

  it('preserves values written without CBOR encoding', () => {
    const value = { legacy: true, nested: { value: 1 } };

    expect(decodeCbor(value)).toEqual(value);
  });
});
