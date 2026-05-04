import type { Firestore, Query } from '@google-cloud/firestore';
import { WorkflowWorldError } from '@workflow/errors';
import type {
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  GetEventParams,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  ListWorkflowRunsParams,
  PaginatedResponse,
  ResolveData,
  RunCreatedEventRequest,
  Step,
  StepWithoutData,
  Storage,
  UpdateStepRequest,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import { HookSchema } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { compact } from './util.js';

interface FirestoreStorageConfig {
  firestore: Firestore;
  deploymentId: string;
}

interface SerializedError {
  message: string;
  stack?: string;
  code?: string;
}

type SerializedStepUpdate = Omit<UpdateStepRequest, 'error'> & {
  error?: SerializedError;
};

function isValidRunData(
  data: unknown
): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function deserializeRunError(data: unknown): WorkflowRun {
  if (!isValidRunData(data)) {
    throw new WorkflowWorldError('Invalid run data', { status: 500 });
  }

  if (!data.error) {
    return data as WorkflowRun;
  }

  const error = data.error as {
    message?: string;
    stack?: string;
    code?: string;
  };
  return {
    ...data,
    error: {
      message: error.message || '',
      stack: error.stack,
      code: error.code,
    },
  } as WorkflowRun;
}

function _serializeStepError(data: UpdateStepRequest): SerializedStepUpdate {
  const baseData = {
    ...data,
  };

  if (!baseData.error) {
    return baseData;
  }

  const { error, ...rest } = baseData;
  return {
    ...rest,
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
  };
}

function isValidStepData(
  data: unknown
): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function deserializeStepError(data: unknown): Step {
  if (!isValidStepData(data)) {
    throw new WorkflowWorldError('Invalid step data', { status: 500 });
  }

  if (!data.error) {
    return data as Step;
  }

  const error = data.error as {
    message?: string;
    stack?: string;
    code?: string;
  };
  return {
    ...data,
    error: {
      message: error.message || '',
      stack: error.stack,
      code: error.code,
    },
  } as Step;
}

function _toFirestoreTimestamp(date: Date | undefined) {
  return date ? new Date(date) : null;
}

interface FirestoreTimestamp {
  toDate(): Date;
}

function isFirestoreTimestamp(value: unknown): value is FirestoreTimestamp {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  );
}

function fromFirestoreTimestamp(timestamp: unknown): Date | undefined {
  if (!timestamp) return undefined;
  if (isFirestoreTimestamp(timestamp)) {
    return timestamp.toDate();
  }
  if (typeof timestamp === 'string' || typeof timestamp === 'number') {
    return new Date(timestamp);
  }
  return undefined;
}

/**
 * Firestore CANNOT store nested arrays (arrays within arrays).
 * This will throw: "Cannot convert an array value in an array value"
 *
 * To work around this, we serialize values that contain nested arrays as JSON strings.
 */
function hasNestedArrays(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (const item of value) {
    if (Array.isArray(item)) return true;
    if (typeof item === 'object' && item !== null && hasNestedArrays(item)) {
      return true;
    }
  }

  return false;
}

/**
 * Serialize a value that might contain nested arrays.
 * If it contains nested arrays, convert to JSON string with a marker.
 */
function serializeNestedArrays(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (hasNestedArrays(value)) {
    // Serialize to JSON with marker
    return JSON.stringify({ __nested_array__: value });
  }

  return value;
}

/**
 * Deserialize a value that might have been serialized to handle nested arrays.
 */
function deserializeNestedArrays(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && '__nested_array__' in parsed) {
      return parsed.__nested_array__;
    }
  } catch {
    // Not JSON, return as-is
  }

  return value;
}

/**
 * Filter data based on ResolveData parameter.
 * When resolveData is 'none', strips specified keys to reduce data transfer.
 */
function filterData<T extends object>(
  data: T,
  resolveData: ResolveData | undefined,
  keysToStrip: (keyof T)[]
): T {
  if (resolveData === 'none') {
    const newData = { ...data };
    for (const key of keysToStrip) {
      if (key in newData) {
        delete newData[key];
      }
    }
    return newData;
  }
  return data;
}

/**
 * Filter hook data based on resolveData parameter
 */
function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === 'none' && 'metadata' in hook) {
    const { metadata: _, ...rest } = hook;
    return { metadata: undefined, ...rest };
  }
  return hook;
}

/**
 * Serialize an error object for Firestore storage.
 */
function serializeError(error: unknown): SerializedError | undefined {
  if (!error) return undefined;
  const err = error as { message?: string; stack?: string; code?: string };
  return {
    message: err.message || '',
    stack: err.stack,
    code: err.code,
  };
}

export function createStorage(config: FirestoreStorageConfig): Storage {
  const { firestore } = config;
  const ulid = monotonicFactory();

  /**
   * Internal helper to get a run from Firestore.
   */
  async function getRun(runId: string): Promise<WorkflowRun> {
    const doc = await firestore.collection('workflow_runs').doc(runId).get();

    if (!doc.exists) {
      throw new WorkflowWorldError(`Run not found: ${runId}`, {
        status: 404,
      });
    }

    const data = doc.data() as FirebaseFirestore.DocumentData;
    return deserializeRunError({
      ...data,
      input: deserializeNestedArrays(data.input),
      output: deserializeNestedArrays(data.output),
      createdAt: fromFirestoreTimestamp(data.createdAt),
      updatedAt: fromFirestoreTimestamp(data.updatedAt),
      startedAt: fromFirestoreTimestamp(data.startedAt),
      completedAt: fromFirestoreTimestamp(data.completedAt),
    });
  }

  /**
   * Internal helper to get a step from Firestore.
   */
  async function getStep(runId: string, stepId: string): Promise<Step> {
    const doc = await firestore
      .collection('workflow_runs')
      .doc(runId)
      .collection('steps')
      .doc(stepId)
      .get();

    if (!doc.exists) {
      throw new WorkflowWorldError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }

    const data = doc.data() as FirebaseFirestore.DocumentData;
    return deserializeStepError({
      ...data,
      input: deserializeNestedArrays(data.input),
      output: deserializeNestedArrays(data.output),
      createdAt: fromFirestoreTimestamp(data.createdAt),
      updatedAt: fromFirestoreTimestamp(data.updatedAt),
      startedAt: fromFirestoreTimestamp(data.startedAt),
      completedAt: fromFirestoreTimestamp(data.completedAt),
      retryAfter: fromFirestoreTimestamp(data.retryAfter),
    });
  }

  /**
   * Internal: create a run entity in Firestore (called from events.create for run_created).
   */
  async function createRunFromEvent(
    runId: string,
    data: RunCreatedEventRequest['eventData']
  ): Promise<WorkflowRun> {
    const runRef = firestore.collection('workflow_runs').doc(runId);

    // Check if run already exists (defensive idempotency)
    const existing = await runRef.get();
    if (existing.exists) {
      const existingData = existing.data() as FirebaseFirestore.DocumentData;
      return deserializeRunError({
        ...existingData,
        input: deserializeNestedArrays(existingData.input),
        output: deserializeNestedArrays(existingData.output),
        createdAt: fromFirestoreTimestamp(existingData.createdAt),
        updatedAt: fromFirestoreTimestamp(existingData.updatedAt),
        startedAt: fromFirestoreTimestamp(existingData.startedAt),
        completedAt: fromFirestoreTimestamp(existingData.completedAt),
      });
    }

    const now = new Date();
    const run = {
      runId,
      workflowName: data.workflowName,
      status: 'pending',
      input: serializeNestedArrays(data.input),
      executionContext: data.executionContext as
        | Record<string, unknown>
        | undefined,
      deploymentId: data.deploymentId,
      createdAt: now,
      updatedAt: now,
    } as any;

    await runRef.set(run);

    return {
      ...run,
      input: data.input,
    } as WorkflowRun;
  }

  /**
   * Internal: update a run entity in Firestore (called from events.create for run_* events).
   */
  async function updateRunFromEvent(
    runId: string,
    eventType: string,
    eventData?: Record<string, unknown>
  ): Promise<WorkflowRun> {
    const currentRun = await getRun(runId);
    const now = new Date();
    const updates: Record<string, unknown> = { updatedAt: now };

    switch (eventType) {
      case 'run_started': {
        updates.status = 'running';
        if (!currentRun.startedAt) {
          updates.startedAt = now;
        }
        if (eventData?.input !== undefined) {
          updates.input = serializeNestedArrays(eventData.input);
        }
        if (eventData?.deploymentId !== undefined) {
          updates.deploymentId = eventData.deploymentId;
        }
        break;
      }
      case 'run_completed': {
        updates.status = 'completed';
        updates.completedAt = now;
        if (eventData?.output !== undefined) {
          updates.output = serializeNestedArrays(eventData.output);
        }
        break;
      }
      case 'run_failed': {
        updates.status = 'failed';
        updates.completedAt = now;
        if (eventData?.error !== undefined) {
          updates.error = serializeError(eventData.error);
        }
        break;
      }
      case 'run_cancelled': {
        updates.status = 'cancelled';
        updates.completedAt = now;
        break;
      }
    }

    await firestore.collection('workflow_runs').doc(runId).update(updates);
    return getRun(runId);
  }

  /**
   * Internal: create a step entity in Firestore (called from events.create for step_created).
   */
  async function createStepFromEvent(
    runId: string,
    stepId: string,
    data: { stepName: string; input: unknown }
  ): Promise<Step> {
    const stepRef = firestore
      .collection('workflow_runs')
      .doc(runId)
      .collection('steps')
      .doc(stepId);

    // Check if step already exists (idempotency)
    const existing = await stepRef.get();
    if (existing.exists) {
      const existingData = existing.data() as FirebaseFirestore.DocumentData;
      return deserializeStepError({
        ...existingData,
        input: deserializeNestedArrays(existingData.input),
        output: deserializeNestedArrays(existingData.output),
        createdAt: fromFirestoreTimestamp(existingData.createdAt),
        updatedAt: fromFirestoreTimestamp(existingData.updatedAt),
        startedAt: fromFirestoreTimestamp(existingData.startedAt),
        completedAt: fromFirestoreTimestamp(existingData.completedAt),
        retryAfter: fromFirestoreTimestamp(existingData.retryAfter),
      });
    }

    const now = new Date();
    const step = {
      runId,
      stepId,
      stepName: data.stepName,
      status: 'pending',
      input: serializeNestedArrays(data.input),
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    } as any;

    await stepRef.set(step);

    return {
      ...step,
      input: data.input,
    } as Step;
  }

  /**
   * Internal: update a step entity in Firestore (called from events.create for step_* events).
   */
  async function updateStepFromEvent(
    runId: string,
    stepId: string,
    eventType: string,
    eventData?: Record<string, unknown>
  ): Promise<Step> {
    const currentStep = await getStep(runId, stepId);
    const now = new Date();
    const updates: Record<string, unknown> = { updatedAt: now };

    switch (eventType) {
      case 'step_started': {
        updates.status = 'running';
        if (!currentStep.startedAt) {
          updates.startedAt = now;
        }
        if (eventData?.attempt !== undefined) {
          updates.attempt = eventData.attempt;
        }
        break;
      }
      case 'step_completed': {
        updates.status = 'completed';
        updates.completedAt = now;
        if (eventData?.result !== undefined) {
          updates.output = serializeNestedArrays(eventData.result);
        }
        break;
      }
      case 'step_failed': {
        updates.status = 'failed';
        updates.completedAt = now;
        if (eventData?.error !== undefined) {
          updates.error = serializeError(eventData.error);
        }
        break;
      }
      case 'step_retrying': {
        updates.status = 'pending';
        if (eventData?.error !== undefined) {
          updates.error = serializeError(eventData.error);
        }
        if (eventData?.retryAfter !== undefined) {
          updates.retryAfter = new Date(eventData.retryAfter as string);
        }
        updates.attempt = (currentStep.attempt || 1) + 1;
        break;
      }
    }

    await firestore
      .collection('workflow_runs')
      .doc(runId)
      .collection('steps')
      .doc(stepId)
      .update(updates);

    return getStep(runId, stepId);
  }

  /**
   * Internal: create a hook entity in Firestore (called from events.create for hook_created).
   */
  async function createHookFromEvent(
    runId: string,
    hookId: string,
    data: { token: string; metadata?: unknown }
  ): Promise<Hook> {
    const now = new Date();

    const hook = {
      runId,
      hookId,
      token: data.token,
      ownerId: '',
      projectId: '',
      environment: '',
      createdAt: now,
      metadata: data.metadata,
    };

    await Promise.all([
      firestore
        .collection('workflow_runs')
        .doc(runId)
        .collection('hooks')
        .doc(hookId)
        .set(hook),
      firestore.collection('hooks_by_token').doc(data.token).set(hook),
    ]);

    return HookSchema.parse(compact(hook));
  }

  return {
    runs: {
      async get(runId: string, params?: GetWorkflowRunParams) {
        const run = await getRun(runId);
        return filterData(run, params?.resolveData, ['input', 'output']);
      },

      async list(
        params?: ListWorkflowRunsParams
      ): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>> {
        const limit = params?.pagination?.limit ?? 20;
        let query: Query = firestore.collection('workflow_runs');

        if (params?.workflowName) {
          query = query.where('workflowName', '==', params.workflowName);
        }

        if (params?.status) {
          query = query.where('status', '==', params.status);
        }

        query = query.orderBy('createdAt', 'desc').limit(limit + 1);

        if (params?.pagination?.cursor) {
          const cursorDoc = await firestore
            .collection('workflow_runs')
            .doc(params.pagination.cursor)
            .get();
          if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
          }
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;

        return {
          data: values.map((doc) => {
            const data = doc.data();
            const run = deserializeRunError({
              ...data,
              input: deserializeNestedArrays(data.input),
              output: deserializeNestedArrays(data.output),
              createdAt: fromFirestoreTimestamp(data.createdAt),
              updatedAt: fromFirestoreTimestamp(data.updatedAt),
              startedAt: fromFirestoreTimestamp(data.startedAt),
              completedAt: fromFirestoreTimestamp(data.completedAt),
            });
            return filterData(run, params?.resolveData, ['input', 'output']);
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },
    } as Storage['runs'],

    events: {
      async create(
        runId: string | null,
        data: RunCreatedEventRequest | CreateEventRequest,
        _params?: CreateEventParams
      ): Promise<EventResult> {
        const eventId = `wevt_${ulid()}`;
        const now = new Date();

        // For run_created events, generate a runId if null
        const effectiveRunId =
          runId ?? (data.eventType === 'run_created' ? `wrun_${ulid()}` : '');

        const eventRecord: Record<string, unknown> = {
          ...data,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
        };

        // Store the event
        await firestore
          .collection('workflow_runs')
          .doc(effectiveRunId)
          .collection('events')
          .doc(eventId)
          .set(eventRecord);

        const event = eventRecord as unknown as Event;
        const result: EventResult = { event };

        // Process entity side effects based on event type
        const eventData = (data as any).eventData;

        switch (data.eventType) {
          case 'run_created': {
            result.run = await createRunFromEvent(
              effectiveRunId,
              eventData as RunCreatedEventRequest['eventData']
            );
            break;
          }
          case 'run_started':
          case 'run_completed':
          case 'run_failed':
          case 'run_cancelled': {
            result.run = await updateRunFromEvent(
              effectiveRunId,
              data.eventType,
              eventData
            );
            break;
          }
          case 'step_created': {
            const correlationId = (data as any).correlationId;
            result.step = await createStepFromEvent(
              effectiveRunId,
              correlationId,
              eventData as { stepName: string; input: unknown }
            );
            break;
          }
          case 'step_started':
          case 'step_completed':
          case 'step_failed':
          case 'step_retrying': {
            const correlationId = (data as any).correlationId;
            result.step = await updateStepFromEvent(
              effectiveRunId,
              correlationId,
              data.eventType,
              eventData
            );
            break;
          }
          case 'hook_created': {
            const correlationId = (data as any).correlationId;
            result.hook = await createHookFromEvent(
              effectiveRunId,
              correlationId,
              eventData as { token: string; metadata?: unknown }
            );
            break;
          }
          // hook_received, hook_disposed, hook_conflict, wait_created, wait_completed
          // are event-only; no entity mutation needed at the storage level
        }

        return result;
      },

      async get(
        runId: string,
        eventId: string,
        _params?: GetEventParams
      ): Promise<Event> {
        const doc = await firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('events')
          .doc(eventId)
          .get();

        if (!doc.exists) {
          throw new WorkflowWorldError(`Event not found: ${eventId}`, {
            status: 404,
          });
        }

        const data = doc.data() as FirebaseFirestore.DocumentData;
        return {
          ...data,
          createdAt: fromFirestoreTimestamp(data.createdAt),
        } as Event;
      },

      async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';

        let query: Query = firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('events')
          .orderBy('createdAt', sortOrder)
          .limit(limit + 1);

        if (params?.pagination?.cursor) {
          const cursorDoc = await firestore
            .collection('workflow_runs')
            .doc(runId)
            .collection('events')
            .doc(params.pagination.cursor)
            .get();
          if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
          }
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;

        return {
          data: values.map((doc) => {
            const data = doc.data();
            return {
              ...data,
              createdAt: fromFirestoreTimestamp(data.createdAt),
            } as Event;
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },

      async listByCorrelationId(params) {
        const { correlationId } = params;
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';

        // Query across all runs for this correlationId
        let query: Query = firestore
          .collectionGroup('events')
          .where('correlationId', '==', correlationId)
          .orderBy('createdAt', sortOrder)
          .limit(limit + 1);

        if (params?.pagination?.cursor) {
          // For collection group queries, use the timestamp value directly
          // Cursor is a serialized ISO timestamp string
          const cursorDate = new Date(params.pagination.cursor);
          query = query.startAfter(cursorDate);
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;

        return {
          data: values.map((doc) => {
            const data = doc.data();
            return {
              ...data,
              createdAt: fromFirestoreTimestamp(data.createdAt),
            } as Event;
          }),
          // Use the createdAt timestamp as cursor for collection group queries
          cursor:
            values.at(-1)?.data().createdAt?.toDate().toISOString() ?? null,
          hasMore,
        };
      },
    },

    steps: {
      async get(
        runId: string | undefined,
        stepId: string,
        params?: GetStepParams
      ) {
        if (!runId) {
          throw new WorkflowWorldError(
            'runId is required for Firestore step lookup',
            { status: 400 }
          );
        }
        const step = await getStep(runId, stepId);
        return filterData(step, params?.resolveData, ['input', 'output']);
      },

      async list(
        params: ListWorkflowRunStepsParams
      ): Promise<PaginatedResponse<Step | StepWithoutData>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 20;

        let query: Query = firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('steps')
          .orderBy('createdAt', 'desc')
          .limit(limit + 1);

        if (params?.pagination?.cursor) {
          const cursorDoc = await firestore
            .collection('workflow_runs')
            .doc(runId)
            .collection('steps')
            .doc(params.pagination.cursor)
            .get();
          if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
          }
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;

        return {
          data: values.map((doc) => {
            const data = doc.data();
            const step = deserializeStepError({
              ...data,
              input: deserializeNestedArrays(data.input),
              output: deserializeNestedArrays(data.output),
              createdAt: fromFirestoreTimestamp(data.createdAt),
              updatedAt: fromFirestoreTimestamp(data.updatedAt),
              startedAt: fromFirestoreTimestamp(data.startedAt),
              completedAt: fromFirestoreTimestamp(data.completedAt),
              retryAfter: fromFirestoreTimestamp(data.retryAfter),
            });
            return filterData(step, params?.resolveData, ['input', 'output']);
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },
    } as Storage['steps'],

    hooks: {
      async get(_hookId: string, _params?: GetHookParams) {
        throw new WorkflowWorldError(
          'Hook lookup by ID not implemented for Firestore',
          {
            status: 501,
          }
        );
      },

      async getByToken(token: string, params?: GetHookParams) {
        const doc = await firestore
          .collection('hooks_by_token')
          .doc(token)
          .get();

        if (!doc.exists) {
          throw new WorkflowWorldError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }

        const data = doc.data() as FirebaseFirestore.DocumentData;
        const parsed = HookSchema.parse({
          runId: data.runId,
          hookId: data.hookId,
          token: data.token,
          ownerId: data.ownerId || '',
          projectId: data.projectId || '',
          environment: data.environment || '',
          createdAt: fromFirestoreTimestamp(data.createdAt) || new Date(),
          metadata: data.metadata,
        });
        const resolveData = params?.resolveData ?? 'all';
        return filterHookData(parsed, resolveData);
      },

      async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
        if (!params.runId) {
          throw new WorkflowWorldError('runId is required for listing hooks', {
            status: 400,
          });
        }
        const runId = params.runId;
        const limit = params?.pagination?.limit ?? 100;

        let query: Query = firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('hooks')
          .orderBy('createdAt', 'desc')
          .limit(limit + 1);

        if (params?.pagination?.cursor) {
          const cursorDoc = await firestore
            .collection('workflow_runs')
            .doc(runId)
            .collection('hooks')
            .doc(params.pagination.cursor)
            .get();
          if (cursorDoc.exists) {
            query = query.startAfter(cursorDoc);
          }
        }

        const snapshot = await query.get();
        const all = snapshot.docs;
        const values = all.slice(0, limit);
        const hasMore = all.length > limit;

        return {
          data: values.map((doc) => {
            const data = doc.data();
            const parsed = HookSchema.parse({
              runId: data.runId,
              hookId: data.hookId,
              token: data.token,
              ownerId: data.ownerId || '',
              projectId: data.projectId || '',
              environment: data.environment || '',
              createdAt: fromFirestoreTimestamp(data.createdAt) || new Date(),
              metadata: data.metadata,
            });
            return filterHookData(parsed, params?.resolveData ?? 'all');
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },
    },
  };
}
