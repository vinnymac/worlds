import { DurableObject } from 'cloudflare:workers';
import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import {
  applyEvent,
  type ApplyEventOutcome,
  type ApplyEventRequest,
  EVENT_KEY_PREFIX,
  type EventStore,
  HOOK_KEY_PREFIX,
  listByPrefix,
  STEP_KEY_PREFIX,
} from '../apply-event.js';

/**
 * Current schema version for DO storage.
 * Increment when making breaking changes to the storage layout.
 * Migrations run lazily on first request after deploy.
 *
 * v2: one storage key per event ('event:<eventId>'), step ('step:<stepId>')
 * and hook ('hook:<hookId>') instead of single aggregate values. This package
 * is pre-production, so the migration simply drops the legacy aggregates.
 */
const CURRENT_SCHEMA_VERSION = 2;

/**
 * Migration functions keyed by target version.
 * Each migration upgrades storage from (version - 1) to version.
 * The transaction parameter provides get/put/delete within a transactional context.
 */
const MIGRATIONS: Record<number, (txn: DurableObjectTransaction) => Promise<void>> = {
  2: async (txn) => {
    // Pre-production layout change: drop the v1 aggregate values.
    await txn.delete('events');
    await txn.delete('steps');
    await txn.delete('hooks');
  },
};

/**
 * Ensure the DO storage schema is up to date.
 * Runs any pending migrations sequentially inside transactions,
 * persisting the version after each successful migration.
 * Safe to call on every request -- it's a no-op when already current.
 */
async function ensureSchemaUpToDate(storage: DurableObjectStorage): Promise<void> {
  const stored = (await storage.get<number>('schema_version')) ?? 1;

  for (let v = stored + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (migration) {
      await storage.transaction(async (txn) => {
        await migration(txn);
        await txn.put('schema_version', v);
      });
    } else {
      await storage.put('schema_version', v);
    }
  }
}

/**
 * Adapt DO storage (or a transaction) to the {@link EventStore} interface
 * shared with the test mocks. No casts: the methods line up structurally,
 * this just pins the subset we rely on.
 */
function storeFrom(storage: DurableObjectStorage | DurableObjectTransaction): EventStore {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    delete: (key) => storage.delete(key),
    list: (options) => storage.list(options),
  };
}

interface InflightClaim {
  messageId: string;
  claimedAt: number;
}

/**
 * Durable Object for managing a single workflow run's state.
 *
 * All event-sourced writes go through {@link applyEvent} inside a single
 * storage transaction: guard checks, the event append, and the entity
 * mutation are atomic even if the DO is evicted mid-operation.
 *
 * Instances named `claim:<queueName>:<idempotencyKey>` are used purely as
 * queue-message dedup claims (see claimInflight/releaseInflight).
 */
export class WorkflowRunDO extends DurableObject {
  private schemaReady: Promise<void> | null = null;
  /**
   * Per-DO monotonic ULID factory. Event ids are allocated inside the DO so
   * their order matches transaction commit order for the run.
   */
  private nextUlid = monotonicFactory();

  /**
   * Lazily ensure schema migrations have run.
   * Memoized so it only runs once per DO instantiation.
   */
  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = ensureSchemaUpToDate(this.ctx.storage);
    }
    return this.schemaReady;
  }

  /**
   * Apply an event: validate, guard, append the event and mutate the entity
   * in ONE storage transaction. Guard failures are returned as structured
   * outcomes (not thrown) because typed errors do not survive the RPC
   * boundary with their `name` intact.
   */
  async applyEvent(request: ApplyEventRequest): Promise<ApplyEventOutcome> {
    await this.ensureSchema();
    return await this.ctx.storage.transaction(async (txn) =>
      applyEvent(storeFrom(txn), {
        ...request,
        nextEventId: () => `wevt_${this.nextUlid()}`,
        now: new Date(),
      }),
    );
  }

  /**
   * Get the workflow run
   */
  async getRun(): Promise<WorkflowRun | null> {
    await this.ensureSchema();
    const run = await this.ctx.storage.get<WorkflowRun>('run');
    return run ?? null;
  }

  /**
   * Get a specific step
   */
  async getStep(stepId: string): Promise<Step | null> {
    await this.ensureSchema();
    const step = await this.ctx.storage.get<Step>(`${STEP_KEY_PREFIX}${stepId}`);
    return step ?? null;
  }

  /**
   * List steps with real limit/cursor pagination (cursor = last stepId).
   */
  async listSteps(params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Step[]; cursor: string | null; hasMore: boolean }> {
    await this.ensureSchema();
    return listByPrefix<Step>(
      storeFrom(this.ctx.storage),
      STEP_KEY_PREFIX,
      { limit: params?.limit ?? 20, cursor: params?.cursor },
      (step) => step.stepId,
    );
  }

  /**
   * Get a specific event
   */
  async getEvent(eventId: string): Promise<Event | null> {
    await this.ensureSchema();
    const event = await this.ctx.storage.get<Event>(`${EVENT_KEY_PREFIX}${eventId}`);
    return event ?? null;
  }

  /**
   * List events with real limit/cursor pagination. Events are keyed by their
   * monotonic ULID eventId, so storage order == event order.
   */
  async listEvents(params?: {
    limit?: number;
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ data: Event[]; cursor: string | null; hasMore: boolean }> {
    await this.ensureSchema();
    return listByPrefix<Event>(
      storeFrom(this.ctx.storage),
      EVENT_KEY_PREFIX,
      {
        limit: params?.limit ?? 100,
        cursor: params?.cursor,
        sortOrder: params?.sortOrder ?? 'asc',
      },
      (event) => event.eventId,
    );
  }

  /**
   * List hooks with real limit/cursor pagination (cursor = last hookId).
   */
  async listHooks(params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Hook[]; cursor: string | null; hasMore: boolean }> {
    await this.ensureSchema();
    return listByPrefix<Hook>(
      storeFrom(this.ctx.storage),
      HOOK_KEY_PREFIX,
      { limit: params?.limit ?? 100, cursor: params?.cursor },
      (hook) => hook.hookId,
    );
  }

  /**
   * Claim a queue-message dedup slot. Used on DO instances dedicated to a
   * single idempotency key (`claim:<queueName>:<idempotencyKey>`).
   *
   * - Unclaimed -> claim and proceed.
   * - Claimed by the SAME messageId -> redelivery of the same message
   *   (previous attempt failed transiently) -> proceed.
   * - Claimed by a DIFFERENT messageId -> concurrent duplicate -> reject,
   *   unless the claim is stale (holder crashed / went to the DLQ without
   *   releasing), in which case the claim is stolen.
   */
  async claimInflight(params: {
    messageId: string;
    staleMs: number;
  }): Promise<{ claimed: boolean }> {
    await this.ensureSchema();
    return await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<InflightClaim>('claim');
      const now = Date.now();
      if (
        existing &&
        existing.messageId !== params.messageId &&
        now - existing.claimedAt < params.staleMs
      ) {
        return { claimed: false };
      }
      await txn.put<InflightClaim>('claim', { messageId: params.messageId, claimedAt: now });
      return { claimed: true };
    });
  }

  /**
   * Release a queue-message dedup claim after the message was fully handled.
   */
  async releaseInflight(): Promise<void> {
    await this.ensureSchema();
    await this.ctx.storage.delete('claim');
  }
}
