import type { CreateEventRequest } from '@workflow/world';
import { expect } from 'vitest';

// Fulfilled entries are ignored; callers assert their own count separately.
export function expectRejectedWith(
  results: readonly PromiseSettledResult<unknown>[],
  errorName: string,
): void {
  for (const result of results) {
    if (result.status === 'rejected') {
      expect(result.reason).toMatchObject({ name: errorName });
    }
  }
}

// Asserts the tag of a discriminated union and narrows to that member.
//
// Workflow events are a union where only some members carry `eventData`, so
// `event.eventData` does not typecheck against the unnarrowed union and a bare
// `as` cast would paper over a genuinely wrong event. The `expect` below is
// what fails the test (and prints the diff); the throw after it is the
// narrowing guard TypeScript needs, and is unreachable once `expect` has
// passed.
export function expectEventType<E extends { eventType: string }, T extends E['eventType']>(
  event: E | undefined,
  eventType: T,
): Extract<E, { eventType: T }> {
  expect(event?.eventType).toBe(eventType);
  if (event?.eventType !== eventType) {
    throw new Error(`expected event of type ${eventType}, got ${event?.eventType ?? 'undefined'}`);
  }
  return event as Extract<E, { eventType: T }>;
}

/**
 * Widens a literal to `CreateEventRequest` for parametrized suites.
 *
 * `test.each` hands the event type in as the union of every case, which defeats
 * narrowing on the discriminated request union: no single `eventData` shape is
 * assignable to all members at once. This is an explicit, test-only widening
 * that asserts nothing. Reach for it only where the tag genuinely comes from a
 * loop, never to silence a mismatch on a fixed event type.
 */
export function asEventRequest(request: unknown): CreateEventRequest {
  return request as CreateEventRequest;
}
