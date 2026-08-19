import { describe, expect, it } from 'vitest';
import {
  DATE_FIELDS,
  dateReviver,
  deepClone,
  hasBinary,
  parse,
  revive,
  stringify,
  uint8ArrayReplacer,
  uint8ArrayReviver,
} from '../src/serialization.js';

describe('serialization', () => {
  describe('DATE_FIELDS', () => {
    it('contains all standard date fields', () => {
      expect(DATE_FIELDS.has('createdAt')).toBe(true);
      expect(DATE_FIELDS.has('updatedAt')).toBe(true);
      expect(DATE_FIELDS.has('startedAt')).toBe(true);
      expect(DATE_FIELDS.has('completedAt')).toBe(true);
      expect(DATE_FIELDS.has('retryAfter')).toBe(true);
    });
  });

  describe('dateReviver', () => {
    it('converts date field ISO strings to Date objects', () => {
      const result = dateReviver('createdAt', '2024-01-15T10:30:00.000Z');
      expect(result).toBeInstanceOf(Date);
      expect((result as Date).toISOString()).toBe('2024-01-15T10:30:00.000Z');
    });

    it('passes through non-date fields unchanged', () => {
      const result = dateReviver('name', '2024-01-15T10:30:00.000Z');
      expect(typeof result).toBe('string');
    });

    it('passes through invalid date strings unchanged', () => {
      const result = dateReviver('createdAt', 'not-a-date');
      expect(result).toBe('not-a-date');
    });

    it('passes through non-string values unchanged', () => {
      const result = dateReviver('createdAt', 12345);
      expect(result).toBe(12345);
    });
  });

  describe('stringify / parse round-trip', () => {
    it('round-trips dates correctly', () => {
      const original = {
        createdAt: new Date('2024-01-15T10:30:00Z'),
        name: 'test',
      };
      const restored = parse<typeof original>(stringify(original));
      expect(restored.createdAt).toBeInstanceOf(Date);
      expect(restored.createdAt.toISOString()).toBe(original.createdAt.toISOString());
      expect(restored.name).toBe('test');
    });

    it('round-trips Uint8Array correctly', () => {
      const original = { data: new Uint8Array([1, 2, 3, 0, 255]) };
      const restored = parse<typeof original>(stringify(original));
      expect(restored.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(restored.data)).toEqual([1, 2, 3, 0, 255]);
    });

    it('handles null bytes in Uint8Array', () => {
      const original = { data: new Uint8Array([0, 0, 0]) };
      const restored = parse<typeof original>(stringify(original));
      expect(restored.data).toEqual(new Uint8Array([0, 0, 0]));
    });

    it('does not modify non-date string fields', () => {
      const original = {
        name: '2024-01-15T10:30:00Z',
        createdAt: new Date('2024-01-15T10:30:00Z'),
      };
      const restored = parse<typeof original>(stringify(original));
      expect(typeof restored.name).toBe('string');
      expect(restored.createdAt).toBeInstanceOf(Date);
    });

    it('handles nested objects with mixed types', () => {
      const original = {
        createdAt: new Date('2024-01-01T00:00:00Z'),
        payload: { data: new Uint8Array([42, 0, 99]) },
        label: 'test',
      };
      const restored = parse<typeof original>(stringify(original));
      expect(restored.createdAt).toBeInstanceOf(Date);
      expect(restored.payload.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(restored.payload.data)).toEqual([42, 0, 99]);
      expect(restored.label).toBe('test');
    });
  });

  describe('uint8ArrayReviver - legacy format', () => {
    it('handles legacy __uint8array marker format', () => {
      const json = JSON.stringify({
        data: { __uint8array: true, data: [1, 2, 3] },
      });
      const restored = parse<{ data: Uint8Array }>(json);
      expect(restored.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(restored.data)).toEqual([1, 2, 3]);
    });

    it('handles legacy format with null bytes', () => {
      const json = JSON.stringify({
        data: { __uint8array: true, data: [0, 0, 0] },
      });
      const restored = parse<{ data: Uint8Array }>(json);
      expect(restored.data).toEqual(new Uint8Array([0, 0, 0]));
    });
  });

  // `parse`/`stringify` skip JSON's reviver/replacer when the payload holds no
  // binary. That fast path must stay indistinguishable from the slow one.
  describe('fast path parity with the reviver/replacer', () => {
    const cases: Array<[string, unknown]> = [
      ['top-level dates', { createdAt: new Date('2024-01-15T10:30:00Z'), name: 'x' }],
      ['nested dates', { eventData: { retryAfter: new Date('2024-02-01T00:00:00Z') }, other: 1 }],
      [
        'deeply nested dates',
        { a: { b: { c: [{ completedAt: new Date('2024-03-01T00:00:00Z') }] } } },
      ],
      ['dates inside arrays', [{ startedAt: new Date('2024-04-01T00:00:00Z') }]],
      ['invalid date string', { createdAt: 'not-a-date' }],
      ['non-string date field', { createdAt: 12345 }],
      ['null values', { createdAt: null, nested: { updatedAt: null } }],
      ['empty object', {}],
      ['empty array', []],
      ['scalar', 42],
      ['binary alongside dates', { createdAt: new Date(0), b: new Uint8Array([1, 0, 255]) }],
      ['deeply nested binary', { a: { b: [{ c: new Uint8Array([9]) }] } }],
    ];

    for (const [label, value] of cases) {
      it(`matches the reviver for: ${label}`, () => {
        const text = stringify(value);
        // The slow path, verbatim, as the reference implementation.
        expect(parse(text)).toEqual(JSON.parse(text, uint8ArrayReviver));
      });
    }

    it('emits byte-identical JSON to the replacer', () => {
      for (const [, value] of cases) {
        expect(stringify(value)).toBe(JSON.stringify(value, uint8ArrayReplacer));
      }
    });

    it('revives a date field nested inside a user payload, as before', () => {
      // The reviver has always done this at any depth; the fast path must not
      // quietly narrow it.
      const restored = parse<{ input: Array<{ createdAt: unknown }> }>(
        JSON.stringify({ input: [{ createdAt: '2024-01-15T10:30:00.000Z' }] }),
      );
      expect(restored.input[0].createdAt).toBeInstanceOf(Date);
    });
  });

  // `revive` must agree with `parse` for transports that hand back decoded
  // objects instead of text.
  describe('revive parity with parse', () => {
    const cases: unknown[] = [
      { createdAt: new Date('2024-01-15T10:30:00Z'), name: 'x' },
      { eventData: { retryAfter: new Date('2024-02-01T00:00:00Z') } },
      { a: { b: { c: [{ completedAt: new Date('2024-03-01T00:00:00Z') }] } } },
      [{ startedAt: new Date('2024-04-01T00:00:00Z') }],
      { data: new Uint8Array([1, 0, 255]) },
      { a: { b: [{ c: new Uint8Array([9]) }] } },
      { createdAt: 'not-a-date' },
      { createdAt: null },
      {},
      [],
    ];

    for (const [i, value] of cases.entries()) {
      it(`matches parse for case ${i}`, () => {
        const text = stringify(value);
        // Simulates a transport that already decoded the JSON for us.
        expect(revive(JSON.parse(text))).toEqual(parse(text));
      });
    }

    it('decodes a bare tagged Uint8Array at the root', () => {
      const restored = revive<Uint8Array>(JSON.parse(stringify(new Uint8Array([1, 2, 3]))));
      expect(restored).toBeInstanceOf(Uint8Array);
      expect(Array.from(restored)).toEqual([1, 2, 3]);
    });

    it('passes scalars through', () => {
      expect(revive(42)).toBe(42);
      expect(revive(null)).toBe(null);
    });
  });

  describe('hasBinary', () => {
    it('detects Uint8Array at any depth', () => {
      expect(hasBinary({ a: { b: [{ c: new Uint8Array([1]) }] } })).toBe(true);
      expect(hasBinary([[[new Uint8Array([1])]]])).toBe(true);
      expect(hasBinary(new Uint8Array([1]))).toBe(true);
    });

    it('returns false for graphs without binary', () => {
      expect(hasBinary({ a: { b: [1, 'x', null, true] } })).toBe(false);
      expect(hasBinary(null)).toBe(false);
      expect(hasBinary('string')).toBe(false);
    });
  });

  describe('deepClone', () => {
    it('creates independent copy', () => {
      const original = { a: 1, nested: { b: 2 } };
      const clone = deepClone(original);
      clone.nested.b = 99;
      expect(original.nested.b).toBe(2);
    });
  });
});
