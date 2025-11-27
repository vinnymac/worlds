import type { Firestore, Query } from '@google-cloud/firestore';
import { WorkflowAPIError } from '@workflow/errors';
import type {
  CreateHookRequest,
  CreateStepRequest,
  Event,
  Hook,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  ListWorkflowRunsParams,
  PaginatedResponse,
  Step,
  Storage,
  UpdateStepRequest,
  UpdateWorkflowRunRequest,
  WorkflowRun,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';

interface FirestoreStorageConfig {
  firestore: Firestore;
  deploymentId: string;
}

interface SerializedError {
  message: string;
  stack?: string;
  code?: string;
}

type SerializedWorkflowRunUpdate = Omit<UpdateWorkflowRunRequest, 'error'> & {
  error?: SerializedError;
};

type SerializedStepUpdate = Omit<UpdateStepRequest, 'error'> & {
  error?: SerializedError;
};

function serializeRunError(
  data: UpdateWorkflowRunRequest
): SerializedWorkflowRunUpdate {
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

function isValidRunData(
  data: unknown
): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function deserializeRunError(data: unknown): WorkflowRun {
  if (!isValidRunData(data)) {
    throw new WorkflowAPIError('Invalid run data', { status: 500 });
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

function serializeStepError(data: UpdateStepRequest): SerializedStepUpdate {
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
    throw new WorkflowAPIError('Invalid step data', { status: 500 });
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

export function createStorage(config: FirestoreStorageConfig): Storage {
  const { firestore } = config;
  const ulid = monotonicFactory();

  return {
    runs: {
      async create(data) {
        const runId = `wrun_${ulid()}`;
        const runRef = firestore.collection('workflow_runs').doc(runId);

        // Check if run already exists (defensive idempotency)
        const existing = await runRef.get();
        if (existing.exists) {
          // Return existing run - DO NOT overwrite
          const existingData =
            existing.data() as FirebaseFirestore.DocumentData;
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

        // Run doesn't exist - create new one
        const now = new Date();
        const run = {
          runId,
          workflowName: data.workflowName,
          status: 'pending',
          // Serialize nested arrays to work around Firestore limitation
          input: serializeNestedArrays(data.input),
          executionContext: data.executionContext as
            | Record<string, unknown>
            | undefined,
          deploymentId: data.deploymentId,
          createdAt: now,
          updatedAt: now,
        } as any;

        await runRef.set(run);

        // Return with original input (not serialized version)
        return {
          ...run,
          input: data.input,
        } as WorkflowRun;
      },

      async get(runId: string) {
        const doc = await firestore
          .collection('workflow_runs')
          .doc(runId)
          .get();

        if (!doc.exists) {
          throw new WorkflowAPIError(`Run not found: ${runId}`, {
            status: 404,
          });
        }

        const data = doc.data() as FirebaseFirestore.DocumentData;
        return deserializeRunError({
          ...data,
          // Deserialize nested arrays that were serialized during storage
          input: deserializeNestedArrays(data.input),
          output: deserializeNestedArrays(data.output),
          createdAt: fromFirestoreTimestamp(data.createdAt),
          updatedAt: fromFirestoreTimestamp(data.updatedAt),
          startedAt: fromFirestoreTimestamp(data.startedAt),
          completedAt: fromFirestoreTimestamp(data.completedAt),
        });
      },

      async cancel(runId: string) {
        const now = new Date();
        await firestore.collection('workflow_runs').doc(runId).update({
          status: 'cancelled',
          completedAt: now,
          updatedAt: now,
        });

        return this.get(runId);
      },

      async pause(runId: string) {
        const now = new Date();
        await firestore.collection('workflow_runs').doc(runId).update({
          status: 'paused',
          updatedAt: now,
        });

        return this.get(runId);
      },

      async resume(runId: string) {
        const currentRun = await this.get(runId);
        const now = new Date();

        const updates: Record<string, unknown> = {
          status: 'running',
          updatedAt: now,
        };

        if (!currentRun.startedAt) {
          updates.startedAt = now;
        }

        await firestore.collection('workflow_runs').doc(runId).update(updates);

        return this.get(runId);
      },

      async update(runId: string, data: UpdateWorkflowRunRequest) {
        const currentRun = await this.get(runId);
        const now = new Date();
        const serialized = serializeRunError(data);

        // Build updates object dynamically - Firestore's UpdateData is too strict for discriminated unions
        const updates: Record<string, unknown> = {
          ...serialized,
          updatedAt: now,
        };

        // Serialize nested arrays in output field
        if ('output' in data && data.output !== undefined) {
          updates.output = serializeNestedArrays(data.output);
        }

        if (data.status === 'running' && !currentRun.startedAt) {
          updates.startedAt = now;
        }

        if (
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled'
        ) {
          updates.completedAt = now;
        }

        await firestore.collection('workflow_runs').doc(runId).update(updates);

        return this.get(runId);
      },

      async list(
        params: ListWorkflowRunsParams
      ): Promise<PaginatedResponse<WorkflowRun>> {
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
            return deserializeRunError({
              ...data,
              // Deserialize nested arrays that were serialized during storage
              input: deserializeNestedArrays(data.input),
              output: deserializeNestedArrays(data.output),
              createdAt: fromFirestoreTimestamp(data.createdAt),
              updatedAt: fromFirestoreTimestamp(data.updatedAt),
              startedAt: fromFirestoreTimestamp(data.startedAt),
              completedAt: fromFirestoreTimestamp(data.completedAt),
            });
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },
    },

    events: {
      async create(runId: string, data) {
        const eventId = `wevt_${ulid()}`;
        const now = new Date();

        const eventData = {
          ...data,
          runId,
          eventId,
          createdAt: now,
        };

        await firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('events')
          .doc(eventId)
          .set(eventData);

        return eventData;
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
      async create(runId: string, data: CreateStepRequest) {
        const stepRef = firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('steps')
          .doc(data.stepId);

        // Check if step already exists (idempotency - prevents overwriting during replay)
        const existing = await stepRef.get();
        if (existing.exists) {
          // Return existing step - DO NOT overwrite completed steps
          const existingData =
            existing.data() as FirebaseFirestore.DocumentData;
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

        // Step doesn't exist - create new one
        const now = new Date();
        const step = {
          runId,
          stepId: data.stepId,
          stepName: data.stepName,
          status: 'pending',
          // Serialize nested arrays to work around Firestore limitation
          input: serializeNestedArrays(data.input),
          attempt: 1,
          createdAt: now,
          updatedAt: now,
        } as any;

        await stepRef.set(step);

        // Return with original input (not serialized version)
        return {
          ...step,
          input: data.input,
        } as Step;
      },

      async get(runId: string, stepId: string) {
        const doc = await firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('steps')
          .doc(stepId)
          .get();

        if (!doc.exists) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }

        const data = doc.data() as FirebaseFirestore.DocumentData;
        return deserializeStepError({
          ...data,
          // Deserialize nested arrays that were serialized during storage
          input: deserializeNestedArrays(data.input),
          output: deserializeNestedArrays(data.output),
          createdAt: fromFirestoreTimestamp(data.createdAt),
          updatedAt: fromFirestoreTimestamp(data.updatedAt),
          startedAt: fromFirestoreTimestamp(data.startedAt),
          completedAt: fromFirestoreTimestamp(data.completedAt),
          retryAfter: fromFirestoreTimestamp(data.retryAfter),
        });
      },

      async update(runId: string, stepId: string, data: UpdateStepRequest) {
        const currentStep = await this.get(runId, stepId);
        const now = new Date();
        const serialized = serializeStepError(data);

        if (process.env.VITEST && data.status) {
          console.log(`[DEBUG] Step update: ${stepId} -> ${data.status}`, {
            attempt: data.attempt || currentStep.attempt,
            hasError: !!data.error,
          });
        }

        // Filter out undefined values to prevent them from overwriting timestamp logic
        const filteredSerialized = Object.entries(serialized).reduce(
          (acc, [key, value]) => {
            if (value !== undefined) {
              acc[key] = value;
            }
            return acc;
          },
          {} as Record<string, unknown>
        );

        const updates: Record<string, unknown> = {
          ...filteredSerialized,
          updatedAt: now,
        };

        // Serialize nested arrays in output field
        if ('output' in data && data.output !== undefined) {
          updates.output = serializeNestedArrays(data.output);
        }

        if (data.status === 'running' && !currentStep.startedAt) {
          updates.startedAt = now;
        }

        if (data.status === 'completed' || data.status === 'failed') {
          updates.completedAt = now;
        }

        await firestore
          .collection('workflow_runs')
          .doc(runId)
          .collection('steps')
          .doc(stepId)
          .update(updates);

        return this.get(runId, stepId);
      },

      async list(
        params: ListWorkflowRunStepsParams
      ): Promise<PaginatedResponse<Step>> {
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
            return deserializeStepError({
              ...data,
              // Deserialize nested arrays that were serialized during storage
              input: deserializeNestedArrays(data.input),
              output: deserializeNestedArrays(data.output),
              createdAt: fromFirestoreTimestamp(data.createdAt),
              updatedAt: fromFirestoreTimestamp(data.updatedAt),
              startedAt: fromFirestoreTimestamp(data.startedAt),
              completedAt: fromFirestoreTimestamp(data.completedAt),
              retryAfter: fromFirestoreTimestamp(data.retryAfter),
            });
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },
    },

    hooks: {
      async create(runId: string, data: CreateHookRequest) {
        const now = new Date();

        const hook = {
          runId,
          hookId: data.hookId,
          token: data.token,
          ownerId: '',
          projectId: '',
          environment: '',
          createdAt: now,
          metadata: undefined,
        };

        await Promise.all([
          firestore
            .collection('workflow_runs')
            .doc(runId)
            .collection('hooks')
            .doc(data.hookId)
            .set(hook),
          firestore.collection('hooks_by_token').doc(data.token).set(hook),
        ]);

        return hook;
      },

      async get(_hookId: string) {
        throw new WorkflowAPIError(
          'Hook lookup by ID not implemented for Firestore',
          {
            status: 501,
          }
        );
      },

      async getByToken(token: string) {
        const doc = await firestore
          .collection('hooks_by_token')
          .doc(token)
          .get();

        if (!doc.exists) {
          throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }

        const data = doc.data() as FirebaseFirestore.DocumentData;
        return {
          runId: data.runId,
          hookId: data.hookId,
          token: data.token,
          ownerId: data.ownerId || '',
          projectId: data.projectId || '',
          environment: data.environment || '',
          createdAt: fromFirestoreTimestamp(data.createdAt) || new Date(),
          metadata: data.metadata,
        };
      },

      async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
        if (!params.runId) {
          throw new WorkflowAPIError('runId is required for listing hooks', {
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
            return {
              runId: data.runId,
              hookId: data.hookId,
              token: data.token,
              ownerId: data.ownerId || '',
              projectId: data.projectId || '',
              environment: data.environment || '',
              createdAt: fromFirestoreTimestamp(data.createdAt) || new Date(),
              metadata: data.metadata,
            };
          }),
          cursor: values.at(-1)?.id ?? null,
          hasMore,
        };
      },

      async dispose(_hookId: string) {
        throw new WorkflowAPIError(
          'Hook disposal by ID not implemented for Firestore',
          {
            status: 501,
          }
        );
      },
    },
  };
}
