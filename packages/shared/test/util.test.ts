import { describe, expect, it, vi } from 'vitest';
import { compact, Mutex, Rc } from '../src/util.js';

describe('compact', () => {
  it('converts null values to undefined', () => {
    const result = compact({ a: 1, b: null, c: 'hello' });
    expect(result).toEqual({ a: 1, b: undefined, c: 'hello' });
  });

  it('preserves non-null values', () => {
    const result = compact({ x: 0, y: '', z: false });
    expect(result).toEqual({ x: 0, y: '', z: false });
  });
});

describe('Mutex', () => {
  it('serializes concurrent operations', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const op1 = mutex.andThen(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });

    const op2 = mutex.andThen(async () => {
      order.push(2);
    });

    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2]);
  });

  it('continues after a rejected operation', async () => {
    const mutex = new Mutex();
    const results: string[] = [];

    await mutex
      .andThen(() => {
        throw new Error('fail');
      })
      .catch(() => {
        results.push('caught');
      });

    await mutex.andThen(() => {
      results.push('recovered');
    });

    expect(results).toEqual(['caught', 'recovered']);
  });
});

describe('Rc', () => {
  it('calls dispose when count reaches zero', async () => {
    const dispose = vi.fn();
    const rc = new Rc(dispose);

    rc.inc();
    rc.inc();
    expect(rc.getCount()).toBe(2);

    await rc.dec();
    expect(dispose).not.toHaveBeenCalled();

    await rc.dec();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not call dispose when no disposeFn provided', async () => {
    const rc = new Rc();
    rc.inc();
    await rc.dec();
    // Should not throw
  });
});
