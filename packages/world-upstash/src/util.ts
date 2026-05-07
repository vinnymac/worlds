import { createDebugLogger } from '@fantasticfour/shared';
import type { Redis } from '@upstash/redis';

export { compact } from '@fantasticfour/shared';
export { stringify, parse } from '@fantasticfour/shared';
export const debug = createDebugLogger('upstash-world');

/**
 * Per-label HTTP request counters for Upstash cost monitoring.
 * Upstash bills per HTTP request; this lets operators track request volume
 * by category (e.g. "storage", "queue", "streamer") to detect cost spikes.
 */
const requestCounts = new Map<string, number>();

/**
 * Return a snapshot of all request counts by label.
 */
export function getRequestStats(): Record<string, number> {
  return Object.fromEntries(requestCounts);
}

/**
 * Reset all request counters (useful in tests).
 */
export function resetRequestStats(): void {
  requestCounts.clear();
}

/**
 * Wrap an Upstash Redis client with a Proxy that increments a per-label
 * counter on every method call. This lets operators monitor how many HTTP
 * requests each subsystem is making.
 *
 * @param redis  The Upstash Redis client to instrument
 * @param label  A category label (e.g. "storage", "streamer")
 * @returns A proxied Redis client that counts every method invocation
 */
export function instrumentRedis<T extends Redis>(redis: T, label: string): T {
  return new Proxy(redis, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;

      return function (this: unknown, ...args: unknown[]) {
        requestCounts.set(label, (requestCounts.get(label) ?? 0) + 1);
        return (orig as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T;
}
