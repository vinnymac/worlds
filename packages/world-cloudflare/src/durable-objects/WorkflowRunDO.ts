import { DurableObject } from 'cloudflare:workers';
import type { CreateWorkflowRunRequest, Event, Hook, Step, WorkflowRun } from '@workflow/world';

/**
 * Current schema version for DO storage.
 * Increment when making breaking changes to the storage layout.
 * Migrations run lazily on first request after deploy.
 */
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Migration functions keyed by target version.
 * Each migration upgrades storage from (version - 1) to version.
 * The transaction parameter provides get/put/delete within a transactional context.
 *
 * Example for future use:
 *   2: async (txn) => {
 *     // Migrate steps from Map to individual keys, etc.
 *     const steps = await txn.get<Map<string, unknown>>('steps');
 *     // ... transform and re-store
 *   },
 */
const MIGRATIONS: Record<number, (txn: DurableObjectTransaction) => Promise<void>> = {
  // Version 1 is the baseline -- no migration needed
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
 * Durable Object for managing a single workflow run's state.
 * Uses Cloudflare's KV storage API for persistence.
 *
 * Multi-step writes are wrapped in storage transactions to guarantee
 * atomicity even if the DO is evicted mid-operation.
 */
export class WorkflowRunDO extends DurableObject {
  private schemaReady: Promise<void> | null = null;

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
   * Create a workflow run
   */
  async createRun(data: CreateWorkflowRunRequest & { runId: string }): Promise<WorkflowRun> {
    await this.ensureSchema();

    const now = new Date();
    const run: WorkflowRun = {
      runId: data.runId,
      workflowName: data.workflowName,
      input: data.input,
      deploymentId: data.deploymentId,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      startedAt: undefined,
      completedAt: undefined,
      output: undefined,
      error: undefined,
      executionContext: data.executionContext as Record<string, any> | undefined,
    };

    await this.ctx.storage.put('run', run);
    return run;
  }

  /**
   * Get the workflow run
   */
  async getRun(): Promise<WorkflowRun | null> {
    await this.ensureSchema();
    const run = await this.ctx.storage.get<WorkflowRun>('run');
    return run || null;
  }

  /**
   * Update the workflow run with automatic timestamp handling.
   * Uses Record<string, unknown> to avoid discriminated union type conflicts.
   * Wrapped in a transaction so the read-modify-write is atomic.
   */
  async updateRun(updates: Record<string, unknown>): Promise<WorkflowRun> {
    await this.ensureSchema();

    return await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<WorkflowRun>('run');
      if (!current) {
        throw new Error('Run not found');
      }

      const now = new Date();
      const updated = {
        ...current,
        ...updates,
        updatedAt: now,
      } as WorkflowRun;

      // Set startedAt when transitioning to 'running'
      if (updates.status === 'running' && !current.startedAt) {
        updated.startedAt = now;
      }

      // Set completedAt when transitioning to terminal states
      if (
        (updates.status === 'completed' ||
          updates.status === 'failed' ||
          updates.status === 'cancelled') &&
        !current.completedAt
      ) {
        updated.completedAt = now;
      }

      await txn.put('run', updated);
      return updated;
    });
  }

  /**
   * Cancel the workflow run
   */
  async cancelRun(updates: Record<string, unknown>): Promise<WorkflowRun> {
    return this.updateRun({
      ...updates,
      status: 'cancelled',
    });
  }

  /**
   * Create a step.
   * Wrapped in a transaction so the read-modify-write of the steps Map is atomic.
   */
  async createStep(stepData: Step): Promise<Step> {
    await this.ensureSchema();

    return await this.ctx.storage.transaction(async (txn) => {
      const stepsMap = (await txn.get<Map<string, Step>>('steps')) || new Map();
      stepsMap.set(stepData.stepId, stepData);
      await txn.put('steps', stepsMap);
      return stepData;
    });
  }

  /**
   * Get a specific step
   */
  async getStep(stepId: string): Promise<Step | null> {
    await this.ensureSchema();
    const stepsMap = await this.ctx.storage.get<Map<string, Step>>('steps');
    if (!stepsMap) {
      return null;
    }
    return stepsMap.get(stepId) || null;
  }

  /**
   * Update a step with automatic timestamp handling.
   * Uses Record<string, unknown> to avoid discriminated union type conflicts.
   * Wrapped in a transaction so the read-modify-write of the steps Map is atomic.
   */
  async updateStep(stepId: string, updates: Record<string, unknown>): Promise<Step> {
    await this.ensureSchema();

    return await this.ctx.storage.transaction(async (txn) => {
      const stepsMap = (await txn.get<Map<string, Step>>('steps')) || new Map();
      const current = stepsMap.get(stepId);

      if (!current) {
        throw new Error(`Step ${stepId} not found`);
      }

      const now = new Date();
      const updated: Step = {
        ...current,
        ...updates,
        updatedAt: now,
      } as Step;

      // Set startedAt when transitioning to 'running'
      if (updates.status === 'running' && !current.startedAt) {
        updated.startedAt = now;
      }

      // Set completedAt when transitioning to terminal states
      if ((updates.status === 'completed' || updates.status === 'failed') && !current.completedAt) {
        updated.completedAt = now;
      }

      stepsMap.set(stepId, updated);
      await txn.put('steps', stepsMap);
      return updated;
    });
  }

  /**
   * List all steps
   */
  async listSteps(_params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Step[]; cursor: null; hasMore: false }> {
    await this.ensureSchema();
    const stepsMap = await this.ctx.storage.get<Map<string, Step>>('steps');
    const steps = stepsMap ? Array.from(stepsMap.values()) : [];
    return {
      data: steps,
      cursor: null,
      hasMore: false,
    };
  }

  /**
   * Create an event.
   * Wrapped in a transaction so the read-append-write of the events array is atomic.
   */
  async createEvent(eventData: Event): Promise<Event> {
    await this.ensureSchema();

    return await this.ctx.storage.transaction(async (txn) => {
      const events = (await txn.get<Event[]>('events')) || [];
      events.push(eventData);
      await txn.put('events', events);
      return eventData;
    });
  }

  /**
   * List all events
   */
  async listEvents(_params?: {
    limit?: number;
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ data: Event[]; cursor: null; hasMore: false }> {
    await this.ensureSchema();
    const events = (await this.ctx.storage.get<Event[]>('events')) || [];
    return {
      data: events,
      cursor: null,
      hasMore: false,
    };
  }

  /**
   * Create a hook.
   * Wrapped in a transaction so the read-modify-write of the hooks Map is atomic.
   */
  async createHook(hookData: Hook): Promise<Hook> {
    await this.ensureSchema();

    return await this.ctx.storage.transaction(async (txn) => {
      const hooksMap = (await txn.get<Map<string, Hook>>('hooks')) || new Map();
      hooksMap.set(hookData.hookId, hookData);
      await txn.put('hooks', hooksMap);
      return hookData;
    });
  }

  /**
   * List all hooks
   */
  async listHooks(_params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Hook[]; cursor: null; hasMore: false }> {
    await this.ensureSchema();
    const hooksMap = await this.ctx.storage.get<Map<string, Hook>>('hooks');
    const hooks = hooksMap ? Array.from(hooksMap.values()) : [];
    return {
      data: hooks,
      cursor: null,
      hasMore: false,
    };
  }
}
