/**
 * Test mocks for Node.js environment
 * Provides mock Durable Object stubs with RPC methods
 */

import type {
  CreateWorkflowRunRequest,
  Event,
  Hook,
  Step,
  WorkflowRun,
} from '@workflow/world';

// In-memory storage for mock Durable Objects
const durableObjectData = new Map<string, Map<string, any>>();
const kvData = new Map<string, string>();

// Get storage for a specific DO instance
const getDOStorage = (doId: string): Map<string, any> => {
  if (!durableObjectData.has(doId)) {
    durableObjectData.set(doId, new Map());
  }
  return durableObjectData.get(doId) as Map<string, any>;
};

/**
 * Mock Durable Object stub with RPC methods
 */
class MockWorkflowRunDOStub {
  constructor(private runId: string) {}

  async createRun(
    data: CreateWorkflowRunRequest & { runId: string }
  ): Promise<WorkflowRun> {
    const storage = getDOStorage(this.runId);
    const run: WorkflowRun = {
      runId: data.runId,
      workflowName: data.workflowName,
      input: data.input,
      deploymentId: data.deploymentId,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: undefined,
      completedAt: undefined,
      output: undefined,
      error: undefined,
      executionContext: data.executionContext as
        | Record<string, any>
        | undefined,
    };
    storage.set('run', run);
    return run;
  }

  async getRun(): Promise<WorkflowRun | null> {
    const storage = getDOStorage(this.runId);
    return storage.get('run') || null;
  }

  async updateRun(updates: any): Promise<WorkflowRun> {
    const storage = getDOStorage(this.runId);
    const current = storage.get('run');
    if (!current) {
      const error = new Error('Run not found') as any;
      error.status = 404;
      throw error;
    }

    const updated = { ...current, ...updates };

    // Auto-set timestamps
    if (updates.status === 'running' && !current.startedAt) {
      updated.startedAt = updates.updatedAt || new Date();
    }
    if (
      (updates.status === 'completed' ||
        updates.status === 'failed' ||
        updates.status === 'cancelled') &&
      !current.completedAt
    ) {
      updated.completedAt = updates.updatedAt || new Date();
    }

    storage.set('run', updated);
    return updated;
  }

  async cancelRun(updates: any): Promise<WorkflowRun> {
    return this.updateRun({ ...updates, status: 'cancelled' });
  }

  async pauseRun(updates: any): Promise<WorkflowRun> {
    return this.updateRun({ ...updates, status: 'paused' });
  }

  async resumeRun(updates: any): Promise<WorkflowRun> {
    return this.updateRun({ ...updates, status: 'running' });
  }

  async createStep(stepData: Step): Promise<Step> {
    const storage = getDOStorage(this.runId);
    const steps = storage.get('steps') || new Map<string, Step>();
    steps.set(stepData.stepId, stepData);
    storage.set('steps', steps);
    return stepData;
  }

  async getStep(stepId: string): Promise<Step | null> {
    const storage = getDOStorage(this.runId);
    const steps = storage.get('steps');
    return steps ? steps.get(stepId) || null : null;
  }

  async updateStep(stepId: string, updates: any): Promise<Step> {
    const storage = getDOStorage(this.runId);
    const steps = storage.get('steps') || new Map<string, Step>();
    const current = steps.get(stepId);
    if (!current) {
      throw new Error(`Step ${stepId} not found`);
    }

    const updated = { ...current, ...updates };

    // Auto-set timestamps
    if (updates.status === 'running' && !current.startedAt) {
      updated.startedAt = updates.updatedAt || new Date();
    }
    if (
      (updates.status === 'completed' || updates.status === 'failed') &&
      !current.completedAt
    ) {
      updated.completedAt = updates.updatedAt || new Date();
    }

    steps.set(stepId, updated);
    storage.set('steps', steps);
    return updated;
  }

  async listSteps(_params?: any): Promise<{
    data: Step[];
    cursor: null;
    hasMore: false;
  }> {
    const storage = getDOStorage(this.runId);
    const steps = storage.get('steps') || new Map<string, Step>();
    return {
      data: Array.from(steps.values()),
      cursor: null,
      hasMore: false,
    };
  }

  async createEvent(eventData: Event): Promise<Event> {
    const storage = getDOStorage(this.runId);
    const events = storage.get('events') || [];
    events.push(eventData);
    storage.set('events', events);
    return eventData;
  }

  async listEvents(_params?: any): Promise<{
    data: Event[];
    cursor: null;
    hasMore: false;
  }> {
    const storage = getDOStorage(this.runId);
    const events = storage.get('events') || [];
    return {
      data: events,
      cursor: null,
      hasMore: false,
    };
  }

  async createHook(hookData: Hook): Promise<Hook> {
    const storage = getDOStorage(this.runId);
    const hooks = storage.get('hooks') || new Map<string, Hook>();
    hooks.set(hookData.hookId, hookData);
    storage.set('hooks', hooks);
    return hookData;
  }

  async listHooks(_params?: any): Promise<{
    data: Hook[];
    cursor: null;
    hasMore: false;
  }> {
    const storage = getDOStorage(this.runId);
    const hooks = storage.get('hooks') || new Map<string, Hook>();
    return {
      data: Array.from(hooks.values()),
      cursor: null,
      hasMore: false,
    };
  }
}

/**
 * Mock KV Namespace
 */
class MockKVNamespace {
  async get(key: string): Promise<string | null> {
    return kvData.get(key) || null;
  }

  async put(key: string, value: string): Promise<void> {
    kvData.set(key, value);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix || '';
    const limit = options?.limit || 1000;

    const matchingKeys = Array.from(kvData.keys())
      .filter((key) => key.startsWith(prefix))
      .sort();

    const keys = matchingKeys.slice(0, limit).map((name) => ({ name }));

    return {
      keys,
      list_complete: keys.length < limit,
    };
  }
}

/**
 * Mock Durable Object Namespace
 */
class MockDurableObjectNamespace {
  private stubs = new Map<string, MockWorkflowRunDOStub>();

  idFromName(name: string): any {
    return { toString: () => name };
  }

  get(id: any): MockWorkflowRunDOStub {
    const idStr = id.toString();
    if (!this.stubs.has(idStr)) {
      this.stubs.set(idStr, new MockWorkflowRunDOStub(idStr));
    }
    return this.stubs.get(idStr) as MockWorkflowRunDOStub;
  }
}

/**
 * Create mock environment for tests
 */
export function createMockEnv() {
  return {
    WORKFLOW_DB: new MockDurableObjectNamespace(),
    WORKFLOW_INDEX: new MockKVNamespace(),
    WORKFLOW_QUEUE: {
      send: async () => {},
    },
    WORKFLOW_STREAMS: {
      idFromName: () => ({ toString: () => 'stream-id' }),
      get: () => ({
        storeChunk: async () => {},
        getChunk: async () => null,
        getAllChunks: async () => [],
      }),
    },
  };
}

/**
 * Clear all mock data (for test cleanup)
 */
export function clearMockData() {
  durableObjectData.clear();
  kvData.clear();
}
