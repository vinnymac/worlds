/**
 * Test mocks for Node.js environment.
 *
 * The mock Durable Object stubs delegate to the SAME transactional
 * event-application core (`apply-event.ts`) as the real WorkflowRunDO, so
 * unit tests exercise the real guard/idempotency/pagination logic; only the
 * storage medium (an in-memory sorted map) is mocked.
 */

import type { Event, Hook, Step, WorkflowRun } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import {
  applyEvent,
  type ApplyEventOutcome,
  type ApplyEventRequest,
  EVENT_KEY_PREFIX,
  type EventStore,
  type EventStoreListOptions,
  HOOK_KEY_PREFIX,
  listByPrefix,
  STEP_KEY_PREFIX,
} from './apply-event.js';

// In-memory storage for mock Durable Objects
const durableObjectData = new Map<string, Map<string, unknown>>();
const kvData = new Map<string, string>();

// Get storage for a specific DO instance
const getDOStorage = (doId: string): Map<string, unknown> => {
  let storage = durableObjectData.get(doId);
  if (!storage) {
    storage = new Map();
    durableObjectData.set(doId, storage);
  }
  return storage;
};

/**
 * In-memory {@link EventStore} over a Map, with lexicographically ordered
 * listing to match Durable Object storage semantics. The backing map is
 * resolved lazily on every operation so stubs survive clearMockData().
 */
function createMemoryStore(getData: () => Map<string, unknown>): EventStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return getData().get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      getData().set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return getData().delete(key);
    },
    async list<T>(options: EventStoreListOptions): Promise<Map<string, T>> {
      const data = getData();
      let keys = Array.from(data.keys())
        .filter((key) => key.startsWith(options.prefix))
        .sort();
      if (options.startAfter !== undefined) {
        const bound = options.startAfter;
        keys = keys.filter((key) => key > bound);
      }
      if (options.end !== undefined) {
        const bound = options.end;
        keys = keys.filter((key) => key < bound);
      }
      if (options.reverse) {
        keys = keys.reverse();
      }
      if (options.limit !== undefined) {
        keys = keys.slice(0, options.limit);
      }
      return new Map(keys.map((key) => [key, data.get(key) as T]));
    },
  };
}

interface InflightClaim {
  messageId: string;
  claimedAt: number;
}

/**
 * Mock Durable Object stub with the same RPC surface as WorkflowRunDO.
 */
class MockWorkflowRunDOStub {
  private store: EventStore;
  private nextUlid = monotonicFactory();

  constructor(runId: string) {
    this.store = createMemoryStore(() => getDOStorage(runId));
  }

  async applyEvent(request: ApplyEventRequest): Promise<ApplyEventOutcome> {
    return applyEvent(this.store, {
      ...request,
      nextEventId: () => `wevt_${this.nextUlid()}`,
      now: new Date(),
    });
  }

  async getRun(): Promise<WorkflowRun | null> {
    const run = await this.store.get<WorkflowRun>('run');
    return run ?? null;
  }

  async getStep(stepId: string): Promise<Step | null> {
    const step = await this.store.get<Step>(`${STEP_KEY_PREFIX}${stepId}`);
    return step ?? null;
  }

  async getEvent(eventId: string): Promise<Event | null> {
    const event = await this.store.get<Event>(`${EVENT_KEY_PREFIX}${eventId}`);
    return event ?? null;
  }

  async listEvents(params?: {
    limit?: number;
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ data: Event[]; cursor: string | null; hasMore: boolean }> {
    return listByPrefix<Event>(
      this.store,
      EVENT_KEY_PREFIX,
      {
        limit: params?.limit ?? 100,
        cursor: params?.cursor,
        sortOrder: params?.sortOrder ?? 'asc',
      },
      (event) => event.eventId,
    );
  }

  async listSteps(params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Step[]; cursor: string | null; hasMore: boolean }> {
    return listByPrefix<Step>(
      this.store,
      STEP_KEY_PREFIX,
      { limit: params?.limit ?? 20, cursor: params?.cursor },
      (step) => step.stepId,
    );
  }

  async listHooks(params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Hook[]; cursor: string | null; hasMore: boolean }> {
    return listByPrefix<Hook>(
      this.store,
      HOOK_KEY_PREFIX,
      { limit: params?.limit ?? 100, cursor: params?.cursor },
      (hook) => hook.hookId,
    );
  }

  async claimInflight(params: { messageId: string; staleMs: number }): Promise<{
    claimed: boolean;
  }> {
    const existing = await this.store.get<InflightClaim>('claim');
    const now = Date.now();
    if (
      existing &&
      existing.messageId !== params.messageId &&
      now - existing.claimedAt < params.staleMs
    ) {
      return { claimed: false };
    }
    await this.store.put<InflightClaim>('claim', { messageId: params.messageId, claimedAt: now });
    return { claimed: true };
  }

  async releaseInflight(): Promise<void> {
    await this.store.delete('claim');
  }
}

/**
 * Mock KV Namespace with real cursor pagination semantics: the cursor
 * continues after the last key returned by the previous list call, and
 * `list_complete` reflects whether further keys exist.
 */
class MockKVNamespace {
  async get(key: string): Promise<string | null> {
    return kvData.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    kvData.set(key, value);
  }

  async delete(key: string): Promise<void> {
    kvData.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix || '';
    const limit = options?.limit || 1000;

    let matchingKeys = Array.from(kvData.keys())
      .filter((key) => key.startsWith(prefix))
      .sort();

    if (options?.cursor) {
      const cursor = options.cursor;
      matchingKeys = matchingKeys.filter((key) => key > cursor);
    }

    const page = matchingKeys.slice(0, limit);
    const listComplete = matchingKeys.length <= limit;

    return {
      keys: page.map((name) => ({ name })),
      list_complete: listComplete,
      cursor: listComplete ? undefined : page.at(-1),
    };
  }
}

/**
 * Mock StreamDO stub with the same RPC surface as the real StreamDO
 * (chunk storage + per-run stream registry roles).
 */
class MockStreamDOStub {
  private chunks: Uint8Array[] = [];
  private closed = false;
  private registry = new Set<string>();

  async writeChunk(data: Uint8Array): Promise<number> {
    if (this.closed) {
      throw new Error('Cannot write to a closed stream');
    }
    this.chunks.push(data);
    return this.chunks.length - 1;
  }

  async closeStream(): Promise<void> {
    this.closed = true;
  }

  async getChunks(params: { startIndex: number; limit: number }): Promise<{
    chunks: Uint8Array[];
    done: boolean;
    tailIndex: number;
  }> {
    const start = Math.max(0, params.startIndex);
    return {
      chunks: this.chunks.slice(start, start + params.limit),
      done: this.closed,
      tailIndex: this.chunks.length - 1,
    };
  }

  async getInfo(): Promise<{ tailIndex: number; done: boolean }> {
    return { tailIndex: this.chunks.length - 1, done: this.closed };
  }

  async registerStream(name: string): Promise<void> {
    this.registry.add(name);
  }

  async listStreams(): Promise<string[]> {
    return Array.from(this.registry).sort();
  }
}

/**
 * Mock Durable Object Namespace
 */
class MockDurableObjectNamespace<T> {
  private stubs = new Map<string, T>();

  constructor(private createStub: (name: string) => T) {}

  idFromName(name: string): { toString(): string } {
    return { toString: () => name };
  }

  get(id: { toString(): string }): T {
    const idStr = id.toString();
    let stub = this.stubs.get(idStr);
    if (!stub) {
      stub = this.createStub(idStr);
      this.stubs.set(idStr, stub);
    }
    return stub;
  }
}

/**
 * Create mock environment for tests
 */
export function createMockEnv() {
  return {
    WORKFLOW_DB: new MockDurableObjectNamespace((name) => new MockWorkflowRunDOStub(name)),
    WORKFLOW_INDEX: new MockKVNamespace(),
    WORKFLOW_QUEUE: {
      send: async () => {},
    },
    WORKFLOW_STREAMS: new MockDurableObjectNamespace(() => new MockStreamDOStub()),
  };
}

/**
 * Clear all mock data (for test cleanup)
 */
export function clearMockData() {
  durableObjectData.clear();
  kvData.clear();
}
