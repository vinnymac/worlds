import { DurableObject } from 'cloudflare:workers';
import type {
  CreateWorkflowRunRequest,
  Event,
  Hook,
  Step,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
} from '@workflow/world';

/**
 * Durable Object for managing a single workflow run's state
 * Uses Cloudflare's KV storage API for persistence
 */
export class WorkflowRunDO extends DurableObject {
  /**
   * Create a workflow run
   */
  async createRun(
    data: CreateWorkflowRunRequest & { runId: string }
  ): Promise<WorkflowRun> {
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
      executionContext: data.executionContext as
        | Record<string, any>
        | undefined,
    };

    await this.ctx.storage.put('run', run);
    return run;
  }

  /**
   * Get the workflow run
   */
  async getRun(): Promise<WorkflowRun | null> {
    const run = await this.ctx.storage.get<WorkflowRun>('run');
    return run || null;
  }

  /**
   * Update the workflow run with automatic timestamp handling
   */
  async updateRun(updates: UpdateWorkflowRunRequest): Promise<WorkflowRun> {
    const current = await this.ctx.storage.get<WorkflowRun>('run');
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

    await this.ctx.storage.put('run', updated);
    return updated;
  }

  /**
   * Cancel the workflow run
   */
  async cancelRun(updates: Partial<WorkflowRun>): Promise<WorkflowRun> {
    return this.updateRun({
      ...updates,
      status: 'cancelled',
    });
  }

  /**
   * Pause the workflow run
   */
  async pauseRun(updates: Partial<WorkflowRun>): Promise<WorkflowRun> {
    return this.updateRun({
      ...updates,
      status: 'paused',
    });
  }

  /**
   * Resume the workflow run
   */
  async resumeRun(updates: Partial<WorkflowRun>): Promise<WorkflowRun> {
    return this.updateRun({
      ...updates,
      status: 'running',
    });
  }

  /**
   * Create a step
   */
  async createStep(stepData: Step): Promise<Step> {
    const stepsMap =
      (await this.ctx.storage.get<Map<string, Step>>('steps')) || new Map();
    stepsMap.set(stepData.stepId, stepData);
    await this.ctx.storage.put('steps', stepsMap);
    return stepData;
  }

  /**
   * Get a specific step
   */
  async getStep(stepId: string): Promise<Step | null> {
    const stepsMap = await this.ctx.storage.get<Map<string, Step>>('steps');
    if (!stepsMap) {
      return null;
    }
    return stepsMap.get(stepId) || null;
  }

  /**
   * Update a step with automatic timestamp handling
   */
  async updateStep(stepId: string, updates: UpdateStepRequest): Promise<Step> {
    const stepsMap =
      (await this.ctx.storage.get<Map<string, Step>>('steps')) || new Map();
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
    if (
      (updates.status === 'completed' || updates.status === 'failed') &&
      !current.completedAt
    ) {
      updated.completedAt = now;
    }

    stepsMap.set(stepId, updated);
    await this.ctx.storage.put('steps', stepsMap);
    return updated;
  }

  /**
   * List all steps
   */
  async listSteps(_params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Step[]; cursor: null; hasMore: false }> {
    const stepsMap = await this.ctx.storage.get<Map<string, Step>>('steps');
    const steps = stepsMap ? Array.from(stepsMap.values()) : [];
    return {
      data: steps,
      cursor: null,
      hasMore: false,
    };
  }

  /**
   * Create an event
   */
  async createEvent(eventData: Event): Promise<Event> {
    const events = (await this.ctx.storage.get<Event[]>('events')) || [];
    events.push(eventData);
    await this.ctx.storage.put('events', events);
    return eventData;
  }

  /**
   * List all events
   */
  async listEvents(_params?: {
    limit?: number;
    cursor?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ data: Event[]; cursor: null; hasMore: false }> {
    const events = (await this.ctx.storage.get<Event[]>('events')) || [];
    return {
      data: events,
      cursor: null,
      hasMore: false,
    };
  }

  /**
   * Create a hook
   */
  async createHook(hookData: Hook): Promise<Hook> {
    const hooksMap =
      (await this.ctx.storage.get<Map<string, Hook>>('hooks')) || new Map();
    hooksMap.set(hookData.hookId, hookData);
    await this.ctx.storage.put('hooks', hooksMap);
    return hookData;
  }

  /**
   * List all hooks
   */
  async listHooks(_params?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ data: Hook[]; cursor: null; hasMore: false }> {
    const hooksMap = await this.ctx.storage.get<Map<string, Hook>>('hooks');
    const hooks = hooksMap ? Array.from(hooksMap.values()) : [];
    return {
      data: hooks,
      cursor: null,
      hasMore: false,
    };
  }
}
