import type { Container, OperationInput, SqlQuerySpec } from '@azure/cosmos';
import { BulkOperationType } from '@azure/cosmos';
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
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import { EventSchema, HookSchema, SPEC_VERSION_CURRENT } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { encodeCbor, decodeCbor } from './cbor.js';
import { compact, withCosmosRetry } from './util.js';

/**
 * Document type discriminators for the single-container model.
 * All documents in `workflow_runs` container share a partition key of /runId
 * and are distinguished by their `type` field.
 */
type DocType = 'run' | 'event' | 'step' | 'hook';

interface CosmosStorageConfig {
  /** Main container for runs, events, steps, hooks (partition key: /runId) */
  container: Container;
  /** Secondary container for O(1) hook lookup by token (partition key: /token) */
  hooksByTokenContainer: Container;
  deploymentId: string;
}

interface SerializedError {
  message: string;
  stack?: string;
  code?: string;
}

function isValidData(data: unknown): data is Record<string, unknown> & { error?: unknown } {
  return typeof data === 'object' && data !== null;
}

function deserializeRunError(data: unknown): WorkflowRun {
  if (!isValidData(data)) {
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

function deserializeStepError(data: unknown): Step {
  if (!isValidData(data)) {
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

/**
 * Cosmos DB stores dates as ISO strings. Convert them back to Date objects.
 */
function fromCosmosTimestamp(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value);
  }
  return undefined;
}

/**
 * Convert Buffer instances to plain Uint8Array.
 * Cosmos DB may return Buffer-like objects for binary data.
 */
function convertBuffersToUint8Array(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return new Uint8Array(
      (value as Uint8Array).buffer,
      (value as Uint8Array).byteOffset,
      (value as Uint8Array).byteLength,
    );
  }

  // Check for serialized Buffer objects: { type: 'Buffer', data: [...] }
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'Buffer' &&
    Array.isArray((value as Record<string, unknown>).data)
  ) {
    return new Uint8Array((value as Record<string, unknown>).data as number[]);
  }

  if (Array.isArray(value)) {
    return value.map(convertBuffersToUint8Array);
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = convertBuffersToUint8Array(val);
    }
    return result;
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
  keysToStrip: (keyof T)[],
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
 * Serialize an error object for Cosmos DB storage.
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

/**
 * Strip Cosmos DB system properties (_rid, _self, _etag, _attachments, _ts, type, id)
 * from a document before returning it to callers.
 */
function stripCosmosMetadata(doc: Record<string, unknown>): Record<string, unknown> {
  const { _rid, _self, _etag, _attachments, _ts, type: _type, id: _id, ...rest } = doc;
  return rest;
}

/**
 * Deserialize a run document from Cosmos DB.
 */
function deserializeRun(doc: Record<string, unknown>): WorkflowRun {
  const data = stripCosmosMetadata(doc);
  return deserializeRunError({
    ...data,
    input: data.input ? decodeCbor(convertBuffersToUint8Array(data.input)) : undefined,
    output: data.output ? decodeCbor(convertBuffersToUint8Array(data.output)) : undefined,
    createdAt: fromCosmosTimestamp(data.createdAt),
    updatedAt: fromCosmosTimestamp(data.updatedAt),
    startedAt: fromCosmosTimestamp(data.startedAt),
    completedAt: fromCosmosTimestamp(data.completedAt),
  });
}

/**
 * Deserialize a step document from Cosmos DB.
 */
function deserializeStep(doc: Record<string, unknown>): Step {
  const data = stripCosmosMetadata(doc);
  return deserializeStepError({
    ...data,
    input: data.input ? decodeCbor(convertBuffersToUint8Array(data.input)) : undefined,
    output: data.output ? decodeCbor(convertBuffersToUint8Array(data.output)) : undefined,
    createdAt: fromCosmosTimestamp(data.createdAt),
    updatedAt: fromCosmosTimestamp(data.updatedAt),
    startedAt: fromCosmosTimestamp(data.startedAt),
    completedAt: fromCosmosTimestamp(data.completedAt),
    retryAfter: fromCosmosTimestamp(data.retryAfter),
  });
}

/**
 * Deserialize an event document from Cosmos DB.
 */
function deserializeEvent(doc: Record<string, unknown>): Event {
  const data = stripCosmosMetadata(doc);
  return {
    ...data,
    eventData: data.eventData ? decodeCbor(convertBuffersToUint8Array(data.eventData)) : undefined,
    createdAt: fromCosmosTimestamp(data.createdAt),
  } as Event;
}

/**
 * Deserialize a hook document from Cosmos DB.
 */
function deserializeHook(doc: Record<string, unknown>): Hook {
  const data = stripCosmosMetadata(doc);
  return HookSchema.parse({
    runId: data.runId,
    hookId: data.hookId,
    token: data.token,
    ownerId: data.ownerId || '',
    projectId: data.projectId || '',
    environment: data.environment || '',
    specVersion: data.specVersion,
    createdAt: fromCosmosTimestamp(data.createdAt) || new Date(),
    metadata: data.metadata ? decodeCbor(convertBuffersToUint8Array(data.metadata)) : undefined,
  });
}

export function createStorage(config: CosmosStorageConfig): Storage {
  const { container, hooksByTokenContainer } = config;
  const ulid = monotonicFactory();

  /**
   * Internal helper to get a run from Cosmos DB.
   */
  async function getRun(runId: string): Promise<WorkflowRun> {
    const querySpec: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE c.type = "run" AND c.runId = @runId',
      parameters: [{ name: '@runId', value: runId }],
    };

    const { resources } = await withCosmosRetry(() =>
      container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
    );

    if (resources.length === 0) {
      throw new WorkflowWorldError(`Run not found: ${runId}`, {
        status: 404,
      });
    }

    return deserializeRun(resources[0]);
  }

  /**
   * Internal helper to get a step from Cosmos DB.
   */
  async function getStep(runId: string, stepId: string): Promise<Step> {
    const querySpec: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE c.type = "step" AND c.stepId = @stepId AND c.runId = @runId',
      parameters: [
        { name: '@stepId', value: stepId },
        { name: '@runId', value: runId },
      ],
    };

    const { resources } = await withCosmosRetry(() =>
      container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
    );

    if (resources.length === 0) {
      throw new WorkflowWorldError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }

    return deserializeStep(resources[0]);
  }

  /**
   * Internal: create a run entity in Cosmos DB (called from events.create for run_created).
   * Uses a transactional batch to atomically create the event and run documents
   * within the same partition (runId).
   */
  async function createRunFromEvent(
    runId: string,
    data: RunCreatedEventRequest['eventData'],
    eventDoc: Record<string, unknown>,
  ): Promise<{ run: WorkflowRun; batchedEvent: true }> {
    const now = new Date();
    const run: Record<string, unknown> = {
      id: `run:${runId}`,
      type: 'run' as DocType,
      runId,
      workflowName: data.workflowName,
      specVersion: SPEC_VERSION_CURRENT,
      status: 'pending',
      input: encodeCbor(data.input),
      executionContext: data.executionContext as Record<string, unknown> | undefined,
      deploymentId: data.deploymentId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      if (typeof container.items.batch === 'function') {
        const operations: OperationInput[] = [
          {
            operationType: BulkOperationType.Create,
            resourceBody: eventDoc as Record<string, any>,
          },
          {
            operationType: BulkOperationType.Create,
            resourceBody: run as Record<string, any>,
          },
        ];
        await withCosmosRetry(() => container.items.batch(operations, runId));
      } else {
        // Fallback for environments without batch support (e.g. emulator/mock)
        await withCosmosRetry(() => container.items.create(eventDoc));
        await withCosmosRetry(() => container.items.create(run));
      }
      return {
        run: {
          ...run,
          createdAt: now,
          updatedAt: now,
        } as unknown as WorkflowRun,
        batchedEvent: true,
      };
    } catch (error: any) {
      // Handle concurrent creation attempts (409 Conflict on batch)
      if (error?.code === 409) {
        return { run: await getRun(runId), batchedEvent: true };
      }
      throw error;
    }
  }

  /**
   * Internal: update a run entity in Cosmos DB (called from events.create for run_* events).
   */
  async function updateRunFromEvent(
    runId: string,
    eventType: string,
    eventData?: Record<string, unknown>,
  ): Promise<WorkflowRun> {
    // Fetch current run document (we need the Cosmos id and full doc for replace)
    const querySpec: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE c.type = "run" AND c.runId = @runId',
      parameters: [{ name: '@runId', value: runId }],
    };

    const { resources } = await withCosmosRetry(() =>
      container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
    );

    if (resources.length === 0) {
      throw new WorkflowWorldError(`Run not found: ${runId}`, { status: 404 });
    }

    const doc = resources[0];
    const now = new Date();
    doc.updatedAt = now.toISOString();

    switch (eventType) {
      case 'run_started': {
        doc.status = 'running';
        if (!doc.startedAt) {
          doc.startedAt = now.toISOString();
        }
        if (eventData?.input !== undefined) {
          doc.input = encodeCbor(eventData.input);
        }
        if (eventData?.deploymentId !== undefined) {
          doc.deploymentId = eventData.deploymentId;
        }
        break;
      }
      case 'run_completed': {
        doc.status = 'completed';
        doc.completedAt = now.toISOString();
        if (eventData?.output !== undefined) {
          doc.output = encodeCbor(eventData.output);
        }
        break;
      }
      case 'run_failed': {
        doc.status = 'failed';
        doc.completedAt = now.toISOString();
        if (eventData?.error !== undefined) {
          doc.error = serializeError(eventData.error);
        }
        break;
      }
      case 'run_cancelled': {
        doc.status = 'cancelled';
        doc.completedAt = now.toISOString();
        break;
      }
    }

    await withCosmosRetry(() => container.item(doc.id, runId).replace(doc));

    // Cleanup hooks when run reaches terminal state
    if (
      eventType === 'run_completed' ||
      eventType === 'run_failed' ||
      eventType === 'run_cancelled'
    ) {
      await cleanupHooks(runId);
    }

    return getRun(runId);
  }

  /**
   * Internal: create a step entity in Cosmos DB (called from events.create for step_created).
   * Uses a transactional batch to atomically create the event and step documents
   * within the same partition (runId).
   */
  async function createStepFromEvent(
    runId: string,
    stepId: string,
    data: { stepName: string; input: unknown },
    eventDoc: Record<string, unknown>,
  ): Promise<{ step: Step; batchedEvent: true }> {
    const now = new Date();
    const step: Record<string, unknown> = {
      id: `step:${runId}:${stepId}`,
      type: 'step' as DocType,
      runId,
      stepId,
      stepName: data.stepName,
      status: 'pending',
      input: encodeCbor(data.input),
      attempt: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      if (typeof container.items.batch === 'function') {
        const operations: OperationInput[] = [
          {
            operationType: BulkOperationType.Create,
            resourceBody: eventDoc as Record<string, any>,
          },
          {
            operationType: BulkOperationType.Create,
            resourceBody: step as Record<string, any>,
          },
        ];
        await withCosmosRetry(() => container.items.batch(operations, runId));
      } else {
        // Fallback for environments without batch support (e.g. emulator/mock)
        await withCosmosRetry(() => container.items.create(eventDoc));
        await withCosmosRetry(() => container.items.create(step));
      }
      return {
        step: {
          ...step,
          createdAt: now,
          updatedAt: now,
        } as unknown as Step,
        batchedEvent: true,
      };
    } catch (error: any) {
      // Handle concurrent creation attempts (409 Conflict on batch)
      if (error?.code === 409) {
        return { step: await getStep(runId, stepId), batchedEvent: true };
      }
      throw error;
    }
  }

  /**
   * Internal: update a step entity in Cosmos DB (called from events.create for step_* events).
   */
  async function updateStepFromEvent(
    runId: string,
    stepId: string,
    eventType: string,
    eventData?: Record<string, unknown>,
  ): Promise<Step> {
    const currentStep = await getStep(runId, stepId);

    // Fetch the raw Cosmos document for replace
    const querySpec: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE c.type = "step" AND c.stepId = @stepId AND c.runId = @runId',
      parameters: [
        { name: '@stepId', value: stepId },
        { name: '@runId', value: runId },
      ],
    };

    const { resources } = await withCosmosRetry(() =>
      container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
    );

    const doc = resources[0];
    const now = new Date();
    doc.updatedAt = now.toISOString();

    switch (eventType) {
      case 'step_started': {
        doc.status = 'running';
        if (!doc.startedAt) {
          doc.startedAt = now.toISOString();
        }
        if (eventData?.attempt !== undefined) {
          doc.attempt = eventData.attempt;
        }
        break;
      }
      case 'step_completed': {
        doc.status = 'completed';
        doc.completedAt = now.toISOString();
        if (eventData?.result !== undefined) {
          doc.output = encodeCbor(eventData.result);
        }
        break;
      }
      case 'step_failed': {
        doc.status = 'failed';
        doc.completedAt = now.toISOString();
        if (eventData?.error !== undefined) {
          doc.error = serializeError(eventData.error);
        }
        break;
      }
      case 'step_retrying': {
        doc.status = 'pending';
        if (eventData?.error !== undefined) {
          doc.error = serializeError(eventData.error);
        }
        if (eventData?.retryAfter !== undefined) {
          doc.retryAfter = new Date(eventData.retryAfter as string).toISOString();
        }
        doc.attempt = (currentStep.attempt || 1) + 1;
        break;
      }
    }

    await withCosmosRetry(() => container.item(doc.id, runId).replace(doc));

    return getStep(runId, stepId);
  }

  /**
   * Internal: create a hook entity in Cosmos DB (called from events.create for hook_created).
   */
  async function createHookFromEvent(
    runId: string,
    hookId: string,
    data: { token: string; metadata?: unknown },
    specVersion: number,
  ): Promise<Hook> {
    const now = new Date();

    const hookDoc: Record<string, unknown> = {
      id: `hook:${runId}:${hookId}`,
      type: 'hook' as DocType,
      runId,
      hookId,
      token: data.token,
      ownerId: '',
      projectId: '',
      environment: '',
      specVersion,
      createdAt: now.toISOString(),
      metadata: encodeCbor(data.metadata),
    };

    const tokenDoc: Record<string, unknown> = {
      id: data.token,
      token: data.token,
      runId,
      hookId,
      ownerId: '',
      projectId: '',
      environment: '',
      specVersion,
      createdAt: now.toISOString(),
      metadata: encodeCbor(data.metadata),
    };

    try {
      // Hook creation spans two containers with different partition keys,
      // so it cannot be batched. Wrap each call with retry instead.
      await Promise.all([
        withCosmosRetry(() => container.items.create(hookDoc)),
        withCosmosRetry(() => hooksByTokenContainer.items.create(tokenDoc)),
      ]);
    } catch (error: any) {
      // Handle concurrent creation attempts (409 Conflict)
      // Note: Can't use upsert() due to emulator bug - it throws 409 instead of upserting
      if (error?.code === 409) {
        const { resource: doc } = await withCosmosRetry(() =>
          container.item(`hook:${runId}:${hookId}`, runId).read(),
        );
        if (!doc) throw error;
        return deserializeHook(doc);
      }
      throw error;
    }

    const parsed = HookSchema.parse(
      compact({
        runId,
        hookId,
        token: data.token,
        ownerId: '',
        projectId: '',
        environment: '',
        specVersion,
        createdAt: now,
        metadata: data.metadata,
      }),
    );
    return parsed;
  }

  /**
   * Internal: cleanup (delete) all hooks for a run when it reaches a terminal state.
   */
  async function cleanupHooks(runId: string): Promise<void> {
    const querySpec: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE c.type = "hook" AND c.runId = @runId',
      parameters: [{ name: '@runId', value: runId }],
    };

    const { resources } = await withCosmosRetry(() =>
      container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
    );

    const deleteOps: Promise<unknown>[] = [];
    for (const doc of resources) {
      deleteOps.push(withCosmosRetry(() => container.item(doc.id, runId).delete()));
      if (doc.token) {
        deleteOps.push(
          withCosmosRetry(() => hooksByTokenContainer.item(doc.token, doc.token).delete()).catch(
            () => {
              // Token doc may already be deleted
            },
          ),
        );
      }
    }
    await Promise.all(deleteOps);
  }

  return {
    runs: {
      async get(runId: string, params?: GetWorkflowRunParams) {
        const run = await getRun(runId);
        return filterData(run, params?.resolveData, ['input', 'output']);
      },

      async list(
        params?: ListWorkflowRunsParams,
      ): Promise<PaginatedResponse<WorkflowRun | WorkflowRunWithoutData>> {
        const limit = params?.pagination?.limit ?? 20;
        const conditions: string[] = ['c.type = "run"'];
        const parameters: { name: string; value: any }[] = [];

        if (params?.workflowName) {
          conditions.push('c.workflowName = @workflowName');
          parameters.push({
            name: '@workflowName',
            value: params.workflowName,
          });
        }

        if (params?.status) {
          conditions.push('c.status = @status');
          parameters.push({ name: '@status', value: params.status });
        }

        if (params?.pagination?.cursor) {
          conditions.push('c.createdAt < @cursor');
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.createdAt DESC OFFSET 0 LIMIT @limit`,
          parameters: [...parameters, { name: '@limit', value: limit + 1 }],
        };

        // Cross-partition query for run listings
        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec, { maxItemCount: limit + 1 }).fetchAll(),
        );

        const values = resources.slice(0, limit);
        const hasMore = resources.length > limit;

        return {
          data: values.map((doc: Record<string, unknown>) => {
            const run = deserializeRun(doc);
            return filterData(run, params?.resolveData, ['input', 'output']);
          }),
          cursor:
            values.length > 0
              ? ((values[values.length - 1] as Record<string, unknown>).createdAt as string)
              : null,
          hasMore,
        };
      },
    } as Storage['runs'],

    events: {
      async create(
        runId: string | null,
        data: RunCreatedEventRequest | CreateEventRequest,
        _params?: CreateEventParams,
      ): Promise<EventResult> {
        const eventId = `wevt_${ulid()}`;
        const now = new Date();

        // For run_created events, generate a runId if null
        const effectiveRunId = runId ?? (data.eventType === 'run_created' ? `wrun_${ulid()}` : '');

        const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

        const eventDoc: Record<string, unknown> = {
          id: `event:${effectiveRunId}:${eventId}`,
          type: 'event' as DocType,
          runId: effectiveRunId,
          eventId,
          eventType: data.eventType,
          eventData: encodeCbor((data as any).eventData || {}),
          specVersion: effectiveSpecVersion,
          createdAt: now.toISOString(),
        };

        // Add optional correlationId if present
        if ('correlationId' in data && (data as any).correlationId !== undefined) {
          eventDoc.correlationId = (data as any).correlationId;
        }

        // Parse and validate using EventSchema
        // Note: Use original eventData (not encoded) for validation
        const parsed = EventSchema.parse({
          ...eventDoc,
          eventData: (data as any).eventData || {},
          createdAt: now,
        });
        const result: EventResult = { event: parsed };

        // Process entity side effects based on event type
        const eventData = (data as any).eventData;

        // For run_created and step_created, use transactional batches that
        // atomically write the event + entity in a single partition-scoped
        // transaction. The event doc is NOT written separately for these cases.
        switch (data.eventType) {
          case 'run_created': {
            const { run } = await createRunFromEvent(
              effectiveRunId,
              eventData as RunCreatedEventRequest['eventData'],
              eventDoc,
            );
            result.run = run;
            break;
          }
          case 'step_created': {
            const correlationId = (data as any).correlationId;
            const { step } = await createStepFromEvent(
              effectiveRunId,
              correlationId,
              eventData as { stepName: string; input: unknown },
              eventDoc,
            );
            result.step = step;
            break;
          }
          default: {
            // All other event types: store the event first, then apply side effects
            await withCosmosRetry(() => container.items.create(eventDoc));

            switch (data.eventType) {
              case 'run_started':
              case 'run_completed':
              case 'run_failed':
              case 'run_cancelled': {
                result.run = await updateRunFromEvent(effectiveRunId, data.eventType, eventData);
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
                  eventData,
                );
                break;
              }
              case 'hook_created': {
                const correlationId = (data as any).correlationId;
                const hookEventData = eventData as {
                  token: string;
                  metadata?: unknown;
                };

                if (!correlationId) {
                  console.error('[hook_created] Missing correlationId');
                }
                if (!hookEventData.token) {
                  console.error('[hook_created] Missing token in eventData');
                }

                result.hook = await createHookFromEvent(
                  effectiveRunId,
                  correlationId,
                  hookEventData,
                  effectiveSpecVersion,
                );
                break;
              }
              // hook_received, hook_disposed, hook_conflict, wait_created, wait_completed
              // are event-only; no entity mutation needed at the storage level
            }
            break;
          }
        }

        return result;
      },

      async get(runId: string, eventId: string, _params?: GetEventParams): Promise<Event> {
        const querySpec: SqlQuerySpec = {
          query:
            'SELECT * FROM c WHERE c.type = "event" AND c.eventId = @eventId AND c.runId = @runId',
          parameters: [
            { name: '@eventId', value: eventId },
            { name: '@runId', value: runId },
          ],
        };

        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
        );

        if (resources.length === 0) {
          throw new WorkflowWorldError(`Event not found: ${eventId}`, {
            status: 404,
          });
        }

        return deserializeEvent(resources[0]);
      },

      async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';
        const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

        const conditions: string[] = ['c.type = "event"', 'c.runId = @runId'];
        const parameters: { name: string; value: any }[] = [{ name: '@runId', value: runId }];

        if (params?.pagination?.cursor) {
          const op = sortOrder === 'asc' ? '>' : '<';
          conditions.push(`c.createdAt ${op} @cursor`);
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.createdAt ${orderDir} OFFSET 0 LIMIT @limit`,
          parameters: [...parameters, { name: '@limit', value: limit + 1 }],
        };

        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
        );

        const values = resources.slice(0, limit);
        const hasMore = resources.length > limit;

        return {
          data: values.map((doc: Record<string, unknown>) => deserializeEvent(doc)),
          cursor:
            values.length > 0
              ? ((values[values.length - 1] as Record<string, unknown>).createdAt as string)
              : null,
          hasMore,
        };
      },

      async listByCorrelationId(params) {
        const { correlationId } = params;
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';
        const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

        const conditions: string[] = ['c.type = "event"', 'c.correlationId = @correlationId'];
        const parameters: { name: string; value: any }[] = [
          { name: '@correlationId', value: correlationId },
        ];

        if (params?.pagination?.cursor) {
          const op = sortOrder === 'asc' ? '>' : '<';
          conditions.push(`c.createdAt ${op} @cursor`);
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.createdAt ${orderDir} OFFSET 0 LIMIT @limit`,
          parameters: [...parameters, { name: '@limit', value: limit + 1 }],
        };

        // Cross-partition query for correlationId lookups
        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec, { maxItemCount: limit + 1 }).fetchAll(),
        );

        const values = resources.slice(0, limit);
        const hasMore = resources.length > limit;

        return {
          data: values.map((doc: Record<string, unknown>) => deserializeEvent(doc)),
          cursor:
            values.length > 0
              ? ((values[values.length - 1] as Record<string, unknown>).createdAt as string)
              : null,
          hasMore,
        };
      },
    },

    steps: {
      async get(runId: string | undefined, stepId: string, params?: GetStepParams) {
        if (!runId) {
          throw new WorkflowWorldError('runId is required for Cosmos DB step lookup', {
            status: 400,
          });
        }
        const step = await getStep(runId, stepId);
        return filterData(step, params?.resolveData, ['input', 'output']);
      },

      async list(
        params: ListWorkflowRunStepsParams,
      ): Promise<PaginatedResponse<Step | StepWithoutData>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 20;

        const conditions: string[] = ['c.type = "step"', 'c.runId = @runId'];
        const parameters: { name: string; value: any }[] = [{ name: '@runId', value: runId }];

        if (params?.pagination?.cursor) {
          conditions.push('c.createdAt < @cursor');
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.createdAt DESC OFFSET 0 LIMIT @limit`,
          parameters: [...parameters, { name: '@limit', value: limit + 1 }],
        };

        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
        );

        const values = resources.slice(0, limit);
        const hasMore = resources.length > limit;

        return {
          data: values.map((doc: Record<string, unknown>) => {
            const step = deserializeStep(doc);
            return filterData(step, params?.resolveData, ['input', 'output']);
          }),
          cursor:
            values.length > 0
              ? ((values[values.length - 1] as Record<string, unknown>).createdAt as string)
              : null,
          hasMore,
        };
      },
    } as Storage['steps'],

    hooks: {
      async get(hookId: string, params?: GetHookParams) {
        // Cross-partition query to find hook by hookId
        const querySpec: SqlQuerySpec = {
          query: 'SELECT * FROM c WHERE c.type = "hook" AND c.hookId = @hookId',
          parameters: [{ name: '@hookId', value: hookId }],
        };

        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec).fetchAll(),
        );

        if (resources.length === 0) {
          throw new WorkflowWorldError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }

        const hook = deserializeHook(resources[0]);
        const resolveData = params?.resolveData ?? 'all';
        return filterHookData(hook, resolveData);
      },

      async getByToken(token: string, params?: GetHookParams) {
        try {
          const { resource } = await withCosmosRetry(() =>
            hooksByTokenContainer.item(token, token).read(),
          );

          if (!resource) {
            throw new WorkflowWorldError(`Hook not found for token: ${token}`, {
              status: 404,
            });
          }

          const hook = deserializeHook(resource);
          const resolveData = params?.resolveData ?? 'all';
          return filterHookData(hook, resolveData);
        } catch (error: unknown) {
          if (error instanceof WorkflowWorldError || (error as { code?: number })?.code === 404) {
            throw new WorkflowWorldError(`Hook not found for token: ${token}`, {
              status: 404,
            });
          }
          throw error;
        }
      },

      async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
        if (!params.runId) {
          throw new WorkflowWorldError('runId is required for listing hooks', {
            status: 400,
          });
        }
        const runId = params.runId;
        const limit = params?.pagination?.limit ?? 100;

        const conditions: string[] = ['c.type = "hook"', 'c.runId = @runId'];
        const parameters: { name: string; value: any }[] = [{ name: '@runId', value: runId }];

        if (params?.pagination?.cursor) {
          conditions.push('c.createdAt < @cursor');
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.createdAt DESC OFFSET 0 LIMIT @limit`,
          parameters: [...parameters, { name: '@limit', value: limit + 1 }],
        };

        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
        );

        const values = resources.slice(0, limit);
        const hasMore = resources.length > limit;

        return {
          data: values.map((doc: Record<string, unknown>) => {
            const hook = deserializeHook(doc);
            return filterHookData(hook, params?.resolveData ?? 'all');
          }),
          cursor:
            values.length > 0
              ? ((values[values.length - 1] as Record<string, unknown>).createdAt as string)
              : null,
          hasMore,
        };
      },
    },
  };
}
