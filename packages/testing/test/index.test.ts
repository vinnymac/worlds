import { describe, expect, it } from 'vitest';
import { expectEventType, expectRejectedWith } from '../src/index.js';

describe('expectRejectedWith', () => {
  it('passes when every rejected entry matches the error name', () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: 'fulfilled', value: 'ok' },
      { status: 'rejected', reason: { name: 'EntityConflictError' } },
      { status: 'rejected', reason: { name: 'EntityConflictError' } },
    ];

    expect(() => expectRejectedWith(results, 'EntityConflictError')).not.toThrow();
  });

  it('fails when a rejected entry has a different error name', () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: 'rejected', reason: { name: 'SomeOtherError' } },
    ];

    expect(() => expectRejectedWith(results, 'EntityConflictError')).toThrow();
  });

  it('ignores fulfilled entries entirely', () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: 'fulfilled', value: 'ok' },
      { status: 'fulfilled', value: 'also ok' },
    ];

    expect(() => expectRejectedWith(results, 'EntityConflictError')).not.toThrow();
  });
});

type Event =
  | { eventType: 'hook_created'; eventData: { token: string } }
  | { eventType: 'hook_conflict'; eventData: { conflictingRunId: string } }
  | { eventType: 'run_cancelled' };

describe('expectEventType', () => {
  it('returns the narrowed member when the tag matches', () => {
    const event: Event = { eventType: 'hook_conflict', eventData: { conflictingRunId: 'run-1' } };

    // Reading `.eventData` here is the point: it only compiles once narrowed.
    expect(expectEventType(event, 'hook_conflict').eventData.conflictingRunId).toBe('run-1');
  });

  it('throws when the tag does not match', () => {
    // Explicit type arguments because the initializer narrows `event` down to
    // the `run_cancelled` member, which would make 'hook_conflict' unassignable
    // to `T` at compile time. Real callers pass an unnarrowed union.
    const event: Event = { eventType: 'run_cancelled' };

    // The inner `expect` fails first, so its assertion message is what surfaces.
    expect(() => expectEventType<Event, 'hook_conflict'>(event, 'hook_conflict')).toThrow(
      /expected 'run_cancelled' to be 'hook_conflict'/,
    );
  });

  it('throws when the event is undefined', () => {
    expect(() => expectEventType<Event, 'hook_conflict'>(undefined, 'hook_conflict')).toThrow(
      /expected undefined to be 'hook_conflict'/,
    );
  });
});
