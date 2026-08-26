import type {
  Container,
  FeedOptions,
  JSONObject,
  OperationInput,
  SqlQuerySpec,
} from '@azure/cosmos';
import { BulkOperationType, PatchOperationType } from '@azure/cosmos';
import {
  EntityConflictError,
  HookNotFoundError,
  PreconditionFailedError,
  RunExpiredError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
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
  Wait,
  WorkflowRun,
  WorkflowRunWithoutData,
} from '@workflow/world';
import {
  EventSchema,
  HookSchema,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  SPEC_VERSION_CURRENT,
  stripEventDataRefs,
  ulidToDate,
  WaitSchema,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { encodeCbor, decodeCbor } from './cbor.js';
import {
  assertBatchCommitted,
  compact,
  isConflictError,
  isNotFoundError,
  isPreconditionFailedError,
  isWrappedBatchError,
  withCosmosRetry,
} from './util.js';

/**
 * Document type discriminators for the single-container model.
 * All documents in `workflow_runs` container share a partition key of /runId
 * and are distinguished by their `type` field.
 */
type DocType = 'run' | 'event' | 'step' | 'hook' | 'wait' | 'marker';

type CosmosDoc = Record<string, unknown>;

/**
 * Maximum optimistic-concurrency retries for etag-guarded entity transitions.
 */
const MAX_TRANSITION_ATTEMPTS = 5;

/** Id of the per-run concurrency marker document. Lives in the run's own
 * partition so it can join the same transactional batch as the event. */
function stateMarkerId(runId: string): string {
  return `marker:${runId}`;
}

/** Event types that advance the state marker when created outside a replay.
 * Narrow by design: core also omits `stateUpdatedAt` on `run_created` /
 * `run_started` / `run_failed`, and advancing there would reject replays. */
const EXTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set(['hook_received', 'step_completed']);

/** Default per-run event ceiling. Mirrors `@workflow/world-local`. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

interface CosmosStorageConfig {
  /** Main container for runs, events, steps, hooks (partition key: /runId) */
  container: Container;
  /** Secondary container for O(1) hook lookup by token (partition key: /token) */
  hooksByTokenContainer: Container;
  deploymentId: string;
  /** Per-run event ceiling reported as `EventResult.maxEvents`. Defaults to
   * `WORKFLOW_MAX_EVENTS` or {@link DEFAULT_MAX_EVENTS_PER_RUN}. */
  maxEventsPerRun?: number;
}

/** Transactional-batch operations enforcing or advancing the state marker,
 * plus the snapshot they were built from. Threaded into every batch so the
 * guard commits or rolls back with the event. */
interface StateGuard {
  operations: OperationInput[];
  /** `CreateEventParams.stateUpdatedAt`, when the caller sent one. */
  stateUpdatedAt?: number;
}

/** Resolve the per-run event ceiling: explicit config, then
 * `WORKFLOW_MAX_EVENTS`, then the default. An explicit value must be a
 * positive integer. */
function resolveMaxEventsPerRun(configured: number | undefined): number {
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) {
      throw new WorkflowWorldError(
        `maxEventsPerRun must be a positive integer, received ${configured}`,
        { status: 500 },
      );
    }
    return configured;
  }
  const raw = process.env.WORKFLOW_MAX_EVENTS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_EVENTS_PER_RUN;
}

/** ULID time (epoch ms) of a prefixed event id, or undefined when it is not
 * a decodable ULID. Mirrors core, which likewise fails open. */
function eventIdTime(eventId: string): number | undefined {
  const underscore = eventId.lastIndexOf('_');
  const rawUlid = underscore === -1 ? eventId : eventId.slice(underscore + 1);
  return ulidToDate(rawUlid)?.getTime();
}

/** A freshly seeded state marker: no externally-originated event yet. */
function newStateMarkerDoc(runId: string): CosmosDoc {
  return {
    id: stateMarkerId(runId),
    type: 'marker' as DocType,
    runId,
    stateUpdatedAt: 0,
  };
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
 * Serialize an event error payload for Cosmos DB storage. Handles both plain
 * string errors and structured { message, stack, code } objects, and lets the
 * event supply an explicit errorCode/stack (run_failed / step_failed carry
 * these alongside the error itself).
 */
function serializeEventError(
  error: unknown,
  overrides: { code?: unknown; stack?: unknown } = {},
): SerializedError {
  const base =
    typeof error === 'object' && error !== null
      ? (error as { message?: string; stack?: string; code?: string })
      : {};
  const message = typeof error === 'string' ? error : (base.message ?? 'Unknown error');
  const stack = typeof overrides.stack === 'string' ? overrides.stack : base.stack;
  const code = typeof overrides.code === 'string' ? overrides.code : base.code;
  return { message, ...(stack !== undefined && { stack }), ...(code !== undefined && { code }) };
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
 * The Cosmos SDK types batch resourceBody as JSONObject, but our documents
 * carry Uint8Array/Buffer CBOR fields that the SDK JSON-serializes on the
 * wire (and that decodeCbor reconstructs on read). Centralize the boundary
 * cast here.
 */
function toResourceBody(doc: CosmosDoc): JSONObject {
  return doc as unknown as JSONObject;
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
    isWebhook: data.isWebhook,
  });
}

/**
 * Deserialize a wait document from Cosmos DB.
 */
function deserializeWait(doc: Record<string, unknown>): Wait {
  return WaitSchema.parse(
    compact({
      waitId: doc.waitId,
      runId: doc.runId,
      status: doc.status,
      resumeAt: doc.resumeAt ?? undefined,
      completedAt: doc.completedAt ?? undefined,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      specVersion: doc.specVersion ?? undefined,
    }),
  );
}

export function createStorage(config: CosmosStorageConfig): Storage {
  const { container, hooksByTokenContainer } = config;
  const ulid = monotonicFactory();
  const maxEventsPerRun = resolveMaxEventsPerRun(config.maxEventsPerRun);

  /** Read the per-run state marker, or undefined for legacy runs and runs with
   * no externally-originated event yet. */
  async function readStateMarker(runId: string): Promise<number | undefined> {
    const doc = await readRunPartitionDoc(runId, stateMarkerId(runId));
    const value = doc?.stateUpdatedAt;
    return typeof value === 'number' ? value : undefined;
  }

  /** Re-read the marker after a rejected batch and translate the rejection into
   * the contract error when the guard caused it. Batch failures arrive without
   * a usable status (see util.ts). */
  async function throwIfStale(runId: string, stateUpdatedAt: number): Promise<void> {
    const marker = await readStateMarker(runId);
    if (marker !== undefined && stateUpdatedAt < marker) {
      throw new PreconditionFailedError(
        `Event creation for run "${runId}" is based on a stale snapshot ` +
          `(stateUpdatedAt ${stateUpdatedAt} < ${marker})`,
      );
    }
  }

  /** Execute a same-partition transactional batch with 429 retry. All event +
   * entity mutations go through here, and `guard` appends the concurrency
   * operations so the marker check commits atomically with the event. */
  async function commitBatch(
    operations: OperationInput[],
    partitionKey: string,
    guard?: StateGuard,
  ) {
    const allOperations = guard ? [...operations, ...guard.operations] : operations;
    try {
      return await withCosmosRetry(async () => {
        // batch() resolves even when the transaction was rejected, so the
        // per-operation statuses have to be inspected explicitly.
        const response = await container.items.batch(allOperations, partitionKey);
        assertBatchCommitted(response);
        return response;
      });
    } catch (error: unknown) {
      if (
        guard?.stateUpdatedAt !== undefined &&
        (isWrappedBatchError(error) || isPreconditionFailedError(error))
      ) {
        await throwIfStale(partitionKey, guard.stateUpdatedAt);
      }
      throw error;
    }
  }

  /** Commit an event document with no same-partition entity mutation. Still a
   * batch, so the state guard commits atomically with the event. */
  function commitEventDoc(eventDoc: CosmosDoc, runId: string, guard: StateGuard) {
    return commitBatch(
      [{ operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) }],
      runId,
      guard,
    );
  }

  /**
   * Internal helper to get the raw run document (with Cosmos system fields).
   */
  function getRunDoc(runId: string): Promise<CosmosDoc | undefined> {
    return readRunPartitionDoc(runId, `run:${runId}`);
  }

  /**
   * Internal helper to get a run from Cosmos DB.
   */
  async function getRun(runId: string): Promise<WorkflowRun> {
    const doc = await getRunDoc(runId);
    if (!doc) {
      throw new WorkflowRunNotFoundError(runId);
    }
    return deserializeRun(doc);
  }

  /**
   * Internal helper to get the raw step document (with Cosmos system fields).
   */
  function getStepDoc(runId: string, stepId: string): Promise<CosmosDoc | undefined> {
    return readRunPartitionDoc(runId, `step:${runId}:${stepId}`);
  }

  /**
   * Internal helper to get a step from Cosmos DB.
   */
  async function getStep(runId: string, stepId: string): Promise<Step> {
    const doc = await getStepDoc(runId, stepId);
    if (!doc) {
      throw new WorkflowWorldError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }
    return deserializeStep(doc);
  }

  /**
   * Internal helper to read a document by id within a run partition.
   * Returns undefined when the document does not exist.
   */
  async function readRunPartitionDoc(runId: string, docId: string): Promise<CosmosDoc | undefined> {
    try {
      const { resource } = await withCosmosRetry(() => container.item(docId, runId).read());
      return (resource as CosmosDoc | undefined) ?? undefined;
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Internal: create a run entity in Cosmos DB (called from events.create for run_created).
   * Uses a transactional batch to atomically create the event and run documents
   * within the same partition (runId).
   */
  async function createRunFromEvent(
    runId: string,
    data: RunCreatedEventRequest['eventData'],
    specVersion: number,
    eventDoc: CosmosDoc,
  ): Promise<{ run: WorkflowRun }> {
    const now = new Date();
    const run: CosmosDoc = {
      id: `run:${runId}`,
      type: 'run' as DocType,
      runId,
      workflowName: data.workflowName,
      specVersion,
      status: 'pending',
      input: encodeCbor(data.input),
      executionContext: data.executionContext as Record<string, unknown> | undefined,
      deploymentId: data.deploymentId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      await commitBatch(
        [
          { operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) },
          { operationType: BulkOperationType.Create, resourceBody: toResourceBody(run) },
          // Seed the state marker with the run so later guarded creates can
          // patch it conditionally (Patch requires the document to exist).
          {
            operationType: BulkOperationType.Create,
            resourceBody: toResourceBody(newStateMarkerDoc(runId)),
          },
        ],
        runId,
      );
    } catch (error: unknown) {
      // The Cosmos SDK wraps transactional-batch failures in a plain Error
      // with no status code, so classify by re-reading the entity: if the
      // run exists, this was a duplicate/concurrent run_created. The runtime
      // swallows EntityConflictError on the raced start() path.
      if (isConflictError(error) || isWrappedBatchError(error)) {
        const existing = await getRunDoc(runId);
        if (existing) {
          throw new EntityConflictError(`Workflow run "${runId}" already exists`);
        }
      }
      throw error;
    }
    return { run: deserializeRun(run) };
  }

  /**
   * Internal: transition a run entity in Cosmos DB (called from events.create
   * for run_started/run_completed/run_failed/run_cancelled).
   *
   * The event document and the entity replace are committed in a single
   * same-partition transactional batch, with the replace guarded by the
   * document etag. On a concurrent write the read-guard-write cycle retries,
   * so a run that raced into a terminal state surfaces as the proper
   * contract error instead of being resurrected, and a terminal event can
   * never be appended without its entity transition.
   */
  async function updateRunFromEvent(
    runId: string,
    eventType: string,
    eventData: Record<string, unknown> | undefined,
    eventDoc: CosmosDoc,
    guard: StateGuard,
  ): Promise<WorkflowRun> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
      const doc = await getRunDoc(runId);
      if (!doc) {
        throw new WorkflowRunNotFoundError(runId);
      }

      const status = doc.status as string;
      const runIsTerminal = isTerminalWorkflowRunStatus(status);
      if (eventType === 'run_started') {
        if (runIsTerminal) {
          throw new RunExpiredError(
            `Workflow run "${runId}" is already in terminal state "${status}"`,
          );
        }
        // Idempotency: run_started on an already running run is a replay.
        // Return existing run state without appending a duplicate event.
        if (status === 'running') {
          return deserializeRun(doc);
        }
      } else if (runIsTerminal) {
        throw new EntityConflictError(`Cannot transition run from terminal state "${status}"`);
      }

      const now = new Date();
      doc.updatedAt = now.toISOString();

      switch (eventType) {
        case 'run_started': {
          doc.status = 'running';
          if (!doc.startedAt) {
            doc.startedAt = now.toISOString();
          }
          // WorkflowRunSchema forbids terminal-only fields on running runs.
          delete doc.error;
          delete doc.output;
          delete doc.completedAt;
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
            doc.error = serializeEventError(eventData.error, { code: eventData.errorCode });
          }
          break;
        }
        case 'run_cancelled': {
          doc.status = 'cancelled';
          doc.completedAt = now.toISOString();
          break;
        }
      }

      try {
        await commitBatch(
          [
            { operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) },
            {
              operationType: BulkOperationType.Replace,
              id: doc.id as string,
              ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
              resourceBody: toResourceBody(doc),
            },
          ],
          runId,
          guard,
        );
      } catch (error: unknown) {
        // Etag mismatch (412 inside the batch) or another wrapped failure:
        // nothing was committed (the batch is atomic), so re-read and re-run
        // the guard. A run that became terminal meanwhile throws above.
        if (isWrappedBatchError(error) || isPreconditionFailedError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      // Cleanup hooks/waits when run reaches terminal state so tokens are
      // released for reuse by future workflows.
      if (
        eventType === 'run_completed' ||
        eventType === 'run_failed' ||
        eventType === 'run_cancelled'
      ) {
        await cleanupRunScopedEntities(runId);
      }

      return deserializeRun(doc);
    }

    throw lastError ?? new WorkflowWorldError(`Failed to transition run "${runId}"`);
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
    eventDoc: CosmosDoc,
    guard: StateGuard,
  ): Promise<{ step: Step }> {
    const now = new Date();
    const step: CosmosDoc = {
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
      await commitBatch(
        [
          { operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) },
          { operationType: BulkOperationType.Create, resourceBody: toResourceBody(step) },
        ],
        runId,
        guard,
      );
    } catch (error: unknown) {
      // See createRunFromEvent: batch errors are opaque, so re-read to
      // classify. Duplicate step_created -> EntityConflictError, which the
      // runtime's concurrent-replay catch path swallows.
      if (isConflictError(error) || isWrappedBatchError(error)) {
        const existing = await getStepDoc(runId, stepId);
        if (existing) {
          throw new EntityConflictError(
            `step_created for correlationId "${stepId}" already exists in run "${runId}"`,
          );
        }
      }
      throw error;
    }
    return { step: deserializeStep(step) };
  }

  /**
   * Internal: transition a step entity in Cosmos DB (called from events.create
   * for step_started/step_completed/step_failed/step_retrying).
   *
   * Same atomic event + etag-guarded replace pattern as updateRunFromEvent.
   */
  async function updateStepFromEvent(
    runId: string,
    stepId: string,
    eventType: string,
    eventData: Record<string, unknown> | undefined,
    eventDoc: CosmosDoc,
    guard: StateGuard,
  ): Promise<Step> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
      const doc = await getStepDoc(runId, stepId);
      if (!doc) {
        throw new WorkflowWorldError(`Step not found: ${stepId}`, { status: 404 });
      }

      const status = doc.status as string;
      if (isTerminalStepStatus(status)) {
        throw new EntityConflictError(`Cannot modify step in terminal state "${status}"`);
      }

      // Retried steps may be scheduled for later; defer early deliveries.
      // Re-checked inside the retry loop so a concurrent step_retrying
      // cannot slip a premature start past the pre-validation.
      if (eventType === 'step_started') {
        const retryAfter = fromCosmosTimestamp(doc.retryAfter);
        if (retryAfter && retryAfter.getTime() > Date.now()) {
          throw new TooEarlyError(
            `Cannot start step "${stepId}": retryAfter timestamp has not been reached yet`,
            {
              retryAfter: Math.ceil((retryAfter.getTime() - Date.now()) / 1000),
            },
          );
        }
      }

      const now = new Date();
      doc.updatedAt = now.toISOString();

      switch (eventType) {
        case 'step_started': {
          doc.status = 'running';
          if (!doc.startedAt) {
            doc.startedAt = now.toISOString();
          }
          // The step is running now; clear any pending retry schedule.
          delete doc.retryAfter;
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
            doc.error = serializeEventError(eventData.error, { stack: eventData.stack });
          }
          break;
        }
        case 'step_retrying': {
          doc.status = 'pending';
          if (eventData?.error !== undefined) {
            doc.error = serializeEventError(eventData.error, { stack: eventData.stack });
          }
          if (eventData?.retryAfter !== undefined) {
            doc.retryAfter = new Date(eventData.retryAfter as string | number | Date).toISOString();
          }
          doc.attempt = (typeof doc.attempt === 'number' ? doc.attempt : 1) + 1;
          break;
        }
      }

      try {
        await commitBatch(
          [
            { operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) },
            {
              operationType: BulkOperationType.Replace,
              id: doc.id as string,
              ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
              resourceBody: toResourceBody(doc),
            },
          ],
          runId,
          guard,
        );
      } catch (error: unknown) {
        if (isWrappedBatchError(error) || isPreconditionFailedError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return deserializeStep(doc);
    }

    throw lastError ?? new WorkflowWorldError(`Failed to transition step "${stepId}"`);
  }

  /**
   * Internal: create a wait entity (called from events.create for wait_created).
   * Duplicate wait_created for the same correlationId -> EntityConflictError,
   * which the runtime's suspended-replay catch path swallows.
   */
  async function createWaitFromEvent(
    runId: string,
    correlationId: string,
    eventData: Record<string, unknown> | undefined,
    specVersion: number,
    eventDoc: CosmosDoc,
    guard: StateGuard,
  ): Promise<Wait> {
    const now = new Date();
    const waitDoc: CosmosDoc = {
      id: `wait:${runId}:${correlationId}`,
      type: 'wait' as DocType,
      runId,
      waitId: `${runId}-${correlationId}`,
      correlationId,
      status: 'waiting',
      resumeAt: fromCosmosTimestamp(eventData?.resumeAt)?.toISOString(),
      specVersion,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      await commitBatch(
        [
          { operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) },
          { operationType: BulkOperationType.Create, resourceBody: toResourceBody(waitDoc) },
        ],
        runId,
        guard,
      );
    } catch (error: unknown) {
      if (isConflictError(error) || isWrappedBatchError(error)) {
        const existing = await readRunPartitionDoc(runId, `wait:${runId}:${correlationId}`);
        if (existing) {
          throw new EntityConflictError(`Wait "${correlationId}" already exists`);
        }
      }
      throw error;
    }
    return deserializeWait(waitDoc);
  }

  /**
   * Internal: transition a wait entity to completed (called from events.create
   * for wait_completed). Duplicate completions -> EntityConflictError so
   * at-least-once wake-up deliveries never append duplicate wait events.
   */
  async function completeWaitFromEvent(
    runId: string,
    correlationId: string,
    eventDoc: CosmosDoc,
    guard: StateGuard,
  ): Promise<Wait> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
      const doc = await readRunPartitionDoc(runId, `wait:${runId}:${correlationId}`);
      if (!doc) {
        throw new WorkflowWorldError(`Wait "${correlationId}" not found`, { status: 404 });
      }
      if (doc.status === 'completed') {
        throw new EntityConflictError(`Wait "${correlationId}" already completed`);
      }

      const now = new Date();
      doc.status = 'completed';
      doc.completedAt = now.toISOString();
      doc.updatedAt = now.toISOString();

      try {
        await commitBatch(
          [
            { operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) },
            {
              operationType: BulkOperationType.Replace,
              id: doc.id as string,
              ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
              resourceBody: toResourceBody(doc),
            },
          ],
          runId,
          guard,
        );
      } catch (error: unknown) {
        if (isWrappedBatchError(error) || isPreconditionFailedError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return deserializeWait(doc);
    }

    throw lastError ?? new WorkflowWorldError(`Failed to complete wait "${correlationId}"`);
  }

  /**
   * Internal: dispose a hook (called from events.create for hook_disposed).
   * Deletes the hook document atomically with the hook_disposed event and
   * releases the token claim so future workflows can reuse the token before
   * the run completes. A concurrent dispose -> EntityConflictError (matching
   * the postgres DELETE ... RETURNING semantics).
   */
  async function disposeHookFromEvent(
    runId: string,
    hookId: string,
    hookDoc: CosmosDoc,
    eventDoc: CosmosDoc,
    guard: StateGuard,
  ): Promise<void> {
    try {
      await commitBatch(
        [
          { operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) },
          { operationType: BulkOperationType.Delete, id: hookDoc.id as string },
        ],
        runId,
        guard,
      );
    } catch (error: unknown) {
      if (isWrappedBatchError(error) || isNotFoundError(error)) {
        const still = await readRunPartitionDoc(runId, hookDoc.id as string);
        if (!still) {
          throw new EntityConflictError(`Hook "${hookId}" already disposed`);
        }
      }
      throw error;
    }

    // Release the token claim, but only while it still points at this hook.
    const token = hookDoc.token;
    if (typeof token === 'string') {
      const claim = await readHookTokenDoc(token);
      if (claim && claim.runId === runId && claim.hookId === hookId) {
        try {
          await withCosmosRetry(() => hooksByTokenContainer.item(token, token).delete());
        } catch (error: unknown) {
          if (!isNotFoundError(error)) throw error;
        }
      }
    }
  }

  /**
   * Internal: read the token-lookup document for a hook token, or undefined if unclaimed.
   */
  async function readHookTokenDoc(token: string): Promise<Record<string, unknown> | undefined> {
    try {
      const { resource } = await withCosmosRetry(() =>
        hooksByTokenContainer.item(token, token).read(),
      );
      return resource ?? undefined;
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Internal: check whether a hook_created event for (runId, hookId) is already
   * in the event log. Used to distinguish a real same-hook duplicate from a
   * crash-orphaned hook document (hook docs written but the hook_created event
   * write never landed).
   */
  async function hasHookCreatedEvent(runId: string, hookId: string): Promise<boolean> {
    const querySpec: SqlQuerySpec = {
      query:
        'SELECT TOP 1 c.eventId FROM c WHERE c.type = "event" AND c.runId = @runId ' +
        'AND c.correlationId = @correlationId AND c.eventType = "hook_created"',
      parameters: [
        { name: '@runId', value: runId },
        { name: '@correlationId', value: hookId },
      ],
    };

    const { resources } = await withCosmosRetry(() =>
      container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
    );
    return resources.length > 0;
  }

  /**
   * Internal: create a hook entity in Cosmos DB (called from events.create for hook_created).
   *
   * Writes the hook documents first and the hook_created event last, so a crash
   * mid-way leaves recoverable orphaned hook docs (no event). Semantics match the
   * reference worlds:
   * - Same-entity duplicate (event already in the log) -> EntityConflictError, so
   *   the runtime's concurrent-replay catch path swallows it (matching step_created).
   * - Crash-orphaned hook docs (no event in the log) -> complete the partial write
   *   by emitting the missing hook_created event.
   * - A different run/hook already holding the token -> store a hook_conflict event
   *   (with conflictingRunId) instead, letting the workflow fail gracefully when
   *   the hook is awaited.
   */
  async function createHookFromEvent(
    runId: string,
    hookId: string,
    data: { token: string; metadata?: unknown; isWebhook?: boolean },
    specVersion: number,
    eventDoc: CosmosDoc,
    guard: StateGuard,
  ): Promise<{ hook?: Hook; conflictEvent?: Event }> {
    const now = new Date();

    const hookDoc: CosmosDoc = {
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
      isWebhook: data.isWebhook,
    };

    const tokenDoc: CosmosDoc = {
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
      isWebhook: data.isWebhook,
    };

    /**
     * The token is already claimed: classify as same-entity duplicate,
     * crash-orphaned partial write, or cross-run conflict.
     */
    async function handleClaimedToken(
      claim: Record<string, unknown>,
    ): Promise<{ hook?: Hook; conflictEvent?: Event }> {
      if (claim.runId === runId && claim.hookId === hookId) {
        if (await hasHookCreatedEvent(runId, hookId)) {
          // Real duplicate: the entity and its event are both committed.
          throw new EntityConflictError(`Hook "${hookId}" already created`);
        }
        // Orphaned hook docs (crash between hook writes and the event write):
        // complete the partial write. The main hook doc may or may not have
        // landed, so tolerate a 409 on re-creating it.
        try {
          await withCosmosRetry(() => container.items.create(hookDoc));
        } catch (error: unknown) {
          if (!isConflictError(error)) throw error;
        }
        await commitEventDoc(eventDoc, runId, guard);
        return { hook: deserializeHook(claim) };
      }

      // Cross-run conflict: a different (runId, hookId) holds this token.
      // Store a hook_conflict event instead of throwing.
      const conflictEventData = {
        token: data.token,
        conflictingRunId: claim.runId as string,
      };
      const conflictDoc: CosmosDoc = {
        id: eventDoc.id,
        type: 'event' as DocType,
        runId,
        eventId: eventDoc.eventId,
        eventType: 'hook_conflict',
        correlationId: hookId,
        eventData: encodeCbor(conflictEventData),
        specVersion,
        createdAt: now.toISOString(),
      };
      await commitEventDoc(conflictDoc, runId, guard);
      const conflictEvent = EventSchema.parse({
        runId,
        eventId: eventDoc.eventId,
        eventType: 'hook_conflict',
        correlationId: hookId,
        eventData: conflictEventData,
        specVersion,
        createdAt: now,
      });
      return { conflictEvent };
    }

    const existingClaim = await readHookTokenDoc(data.token);
    if (existingClaim) {
      return handleClaimedToken(existingClaim);
    }

    // Claim the token first; it is the uniqueness anchor. A 409 here means a
    // concurrent writer won the race; re-read and classify.
    // Note: Can't use upsert() due to emulator bug - it throws 409 instead of upserting
    try {
      await withCosmosRetry(() => hooksByTokenContainer.items.create(tokenDoc));
    } catch (error: unknown) {
      if (isConflictError(error)) {
        const racedClaim = await readHookTokenDoc(data.token);
        if (racedClaim) {
          return handleClaimedToken(racedClaim);
        }
      }
      throw error;
    }

    // The main hook doc may already exist from a prior partial write with
    // identical content.
    try {
      await withCosmosRetry(() => container.items.create(hookDoc));
    } catch (error: unknown) {
      if (!isConflictError(error)) throw error;
    }

    // Commit the hook_created event last so a crash above leaves orphaned hook
    // docs that the recovery path can complete instead of an event without entity.
    await commitEventDoc(eventDoc, runId, guard);

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
        isWebhook: data.isWebhook,
      }),
    );
    return { hook: parsed };
  }

  /**
   * Internal: cleanup (delete) all hooks and waits for a run when it reaches
   * a terminal state, releasing hook tokens for reuse.
   */
  async function cleanupRunScopedEntities(runId: string): Promise<void> {
    const querySpec: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE (c.type = "hook" OR c.type = "wait") AND c.runId = @runId',
      parameters: [{ name: '@runId', value: runId }],
    };

    const { resources } = await withCosmosRetry(() =>
      container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
    );

    const deleteOps: Promise<unknown>[] = [];
    for (const doc of resources) {
      deleteOps.push(
        withCosmosRetry(() => container.item(doc.id, runId).delete()).catch((error: unknown) => {
          // Already deleted by a concurrent cleanup
          if (!isNotFoundError(error)) throw error;
        }),
      );
      if (doc.type === 'hook' && doc.token) {
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
        const parameters: { name: string; value: string | number }[] = [];

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

        // Order and paginate by runId (monotonic ULID); createdAt has
        // millisecond precision, so cursor pagination on it can skip runs
        // sharing the boundary timestamp.
        if (params?.pagination?.cursor) {
          conditions.push('c.runId < @cursor');
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.runId DESC OFFSET 0 LIMIT @limit`,
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
              ? ((values[values.length - 1] as Record<string, unknown>).runId as string)
              : null,
          hasMore,
        };
      },
    } as Storage['runs'],

    events: {
      async create(
        runId: string | null,
        data: RunCreatedEventRequest | CreateEventRequest,
        params?: CreateEventParams,
      ): Promise<EventResult> {
        const now = new Date();
        // Resolved once so every return site below strips the same way.
        const resolveData = params?.resolveData ?? 'all';

        // For run_created events, generate a runId if null
        const effectiveRunId = runId ?? (data.eventType === 'run_created' ? `wrun_${ulid()}` : '');

        const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
        const correlationId = 'correlationId' in data ? data.correlationId : undefined;
        const eventData =
          'eventData' in data ? (data.eventData as Record<string, unknown> | undefined) : undefined;

        // ============================================================
        // RESILIENT START: Bootstrap run from run_started eventData.
        // Runs BEFORE the main eventId is allocated so the synthetic
        // run_created ULID orders before this run_started in the
        // eventId-sorted log.
        // ============================================================
        if (data.eventType === 'run_started' && eventData) {
          const runInputData = eventData as {
            deploymentId?: string;
            workflowName?: string;
            input?: unknown;
            executionContext?: Record<string, unknown>;
          };
          if (
            runInputData.deploymentId &&
            runInputData.workflowName &&
            runInputData.input !== undefined &&
            !(await getRunDoc(effectiveRunId))
          ) {
            const runCreatedEventId = `wevt_${ulid()}`;
            const runDoc: CosmosDoc = {
              id: `run:${effectiveRunId}`,
              type: 'run' as DocType,
              runId: effectiveRunId,
              workflowName: runInputData.workflowName,
              specVersion: effectiveSpecVersion,
              status: 'pending',
              input: encodeCbor(runInputData.input),
              executionContext: runInputData.executionContext,
              deploymentId: runInputData.deploymentId,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            };
            const syntheticEventDoc: CosmosDoc = {
              id: `event:${effectiveRunId}:${runCreatedEventId}`,
              type: 'event' as DocType,
              runId: effectiveRunId,
              eventId: runCreatedEventId,
              eventType: 'run_created',
              eventData: encodeCbor({
                deploymentId: runInputData.deploymentId,
                workflowName: runInputData.workflowName,
                input: runInputData.input,
                executionContext: runInputData.executionContext,
              }),
              specVersion: effectiveSpecVersion,
              createdAt: now.toISOString(),
            };
            try {
              await commitBatch(
                [
                  {
                    operationType: BulkOperationType.Create,
                    resourceBody: toResourceBody(syntheticEventDoc),
                  },
                  { operationType: BulkOperationType.Create, resourceBody: toResourceBody(runDoc) },
                  // Seed the state marker with the bootstrapped run, matching
                  // createRunFromEvent.
                  {
                    operationType: BulkOperationType.Create,
                    resourceBody: toResourceBody(newStateMarkerDoc(effectiveRunId)),
                  },
                ],
                effectiveRunId,
              );
            } catch (error: unknown) {
              // A concurrent run_created won the race; the run exists,
              // which is all the bootstrap needs.
              if (isConflictError(error) || isWrappedBatchError(error)) {
                if (!(await getRunDoc(effectiveRunId))) throw error;
              } else {
                throw error;
              }
            }
          }
        }

        const eventId = `wevt_${ulid()}`;

        const eventDoc: CosmosDoc = {
          id: `event:${effectiveRunId}:${eventId}`,
          type: 'event' as DocType,
          runId: effectiveRunId,
          eventId,
          eventType: data.eventType,
          eventData: encodeCbor(eventData || {}),
          specVersion: effectiveSpecVersion,
          createdAt: now.toISOString(),
        };

        // Strip eventData from run_started events before storage
        if (data.eventType === 'run_started') {
          delete eventDoc.eventData;
        }

        // Add optional correlationId if present
        if (correlationId !== undefined) {
          eventDoc.correlationId = correlationId;
        }

        // Parse and validate using EventSchema
        // Note: Use original eventData (not encoded) for validation
        const parsedInput: Record<string, unknown> = {
          ...eventDoc,
          eventData: eventData || {},
          createdAt: now,
        };
        // Strip eventData from run_started events
        if (data.eventType === 'run_started') {
          delete parsedInput.eventData;
        }
        const parsed = EventSchema.parse(parsedInput);
        const result: EventResult = { event: stripEventDataRefs(parsed, resolveData) };

        // Cosmos has no serializable read, so the guard is a conditional Patch on the
        // marker inside the same transactional batch as the event write. Strictly
        // older snapshots are rejected; equal passes and absent fails open.
        const stateUpdatedAt = params?.stateUpdatedAt;
        const guard: StateGuard = { operations: [], stateUpdatedAt };
        if (stateUpdatedAt !== undefined) {
          const marker = await readStateMarker(effectiveRunId);
          if (marker !== undefined) {
            if (stateUpdatedAt < marker) {
              throw new PreconditionFailedError(
                `Event creation for run "${effectiveRunId}" is based on a stale snapshot ` +
                  `(stateUpdatedAt ${stateUpdatedAt} < ${marker})`,
              );
            }
            guard.operations.push({
              operationType: BulkOperationType.Patch,
              id: stateMarkerId(effectiveRunId),
              resourceBody: {
                // Numeric literal built from a number we validated above, so
                // there is nothing to interpolate unsafely.
                condition: `from c where c.stateUpdatedAt <= ${stateUpdatedAt}`,
                operations: [
                  { op: PatchOperationType.set, path: '/guardCheckedAt', value: now.getTime() },
                ],
              },
            });
          }
          // No marker document => run predates the guard (or has recorded no
          // externally-originated event): nothing to be stale against.
        } else if (EXTERNAL_EVENT_TYPES.has(data.eventType)) {
          // Externally originated: this event becomes the new marker. Unconditional
          // Upsert so a fan-out never contends on an etag; a racing advance can only
          // leave the marker behind, which weakens the guard but never rejects.
          const time = eventIdTime(eventId);
          const marker = await readStateMarker(effectiveRunId);
          if (time !== undefined && (marker === undefined || time > marker)) {
            guard.operations.push({
              operationType: BulkOperationType.Upsert,
              resourceBody: toResourceBody({
                ...newStateMarkerDoc(effectiveRunId),
                stateUpdatedAt: time,
              }),
            });
          }
        }

        // ============================================================
        // VALIDATION: terminal-state and event-ordering guards.
        // These run BEFORE the event document is written so rejected
        // duplicates can never corrupt the replay log. The runtime
        // relies on these errors (see @workflow/core step/run handlers):
        // - RunExpiredError: run already terminal -> skip the message
        // - EntityConflictError: duplicate/terminal entity -> treat as
        //   an idempotent concurrent replay and continue
        // - TooEarlyError: step retryAfter not reached -> defer via queue
        // ============================================================
        const runGuardedEvents = [
          'run_started',
          'run_completed',
          'run_failed',
          'run_cancelled',
          'step_created',
          'hook_created',
          'wait_created',
        ];
        let currentRun: WorkflowRun | undefined;
        if (runGuardedEvents.includes(data.eventType)) {
          currentRun = await getRun(effectiveRunId);
          const runIsTerminal = isTerminalWorkflowRunStatus(currentRun.status);

          switch (data.eventType) {
            case 'run_started': {
              // For run_started on terminal runs, use RunExpiredError so the
              // runtime knows to exit without retrying.
              if (runIsTerminal) {
                throw new RunExpiredError(
                  `Workflow run "${effectiveRunId}" is already in terminal state "${currentRun.status}"`,
                );
              }
              break;
            }
            case 'run_cancelled': {
              // Idempotent operation: run_cancelled on an already cancelled run
              // records the event without re-transitioning the run.
              if (currentRun.status === 'cancelled') {
                await commitEventDoc(eventDoc, effectiveRunId, guard);
                result.run = currentRun;
                return result;
              }
              if (runIsTerminal) {
                throw new EntityConflictError(
                  `Cannot transition run from terminal state "${currentRun.status}"`,
                );
              }
              break;
            }
            case 'run_completed':
            case 'run_failed': {
              if (runIsTerminal) {
                throw new EntityConflictError(
                  `Cannot transition run from terminal state "${currentRun.status}"`,
                );
              }
              break;
            }
            default: {
              // step_created / hook_created / wait_created
              if (runIsTerminal) {
                throw new EntityConflictError(
                  `Cannot create new entities on run in terminal state "${currentRun.status}"`,
                );
              }
            }
          }
        }

        const stepGuardedEvents = [
          'step_started',
          'step_completed',
          'step_failed',
          'step_retrying',
        ];
        if (stepGuardedEvents.includes(data.eventType) && correlationId) {
          // Event ordering: the step must exist before these events (404 otherwise)
          const currentStep = await getStep(effectiveRunId, correlationId);
          if (isTerminalStepStatus(currentStep.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${currentStep.status}"`,
            );
          }
          // Retried steps may be scheduled for later; defer early deliveries.
          if (
            data.eventType === 'step_started' &&
            currentStep.retryAfter &&
            currentStep.retryAfter.getTime() > Date.now()
          ) {
            throw new TooEarlyError(
              `Cannot start step "${correlationId}": retryAfter timestamp has not been reached yet`,
              {
                retryAfter: Math.ceil((currentStep.retryAfter.getTime() - Date.now()) / 1000),
              },
            );
          }
        }

        // Event ordering: hook_received/hook_disposed require an existing hook.
        let existingHookDoc: CosmosDoc | undefined;
        if (
          (data.eventType === 'hook_received' || data.eventType === 'hook_disposed') &&
          correlationId
        ) {
          existingHookDoc = await readRunPartitionDoc(
            effectiveRunId,
            `hook:${effectiveRunId}:${correlationId}`,
          );
          if (!existingHookDoc) {
            throw new HookNotFoundError(correlationId);
          }
        }

        // Entity side effects. All entity-bearing events commit the event
        // document and the entity mutation in one same-partition
        // transactional batch; the event doc is never written separately
        // for these cases.
        switch (data.eventType) {
          case 'run_created': {
            const { run } = await createRunFromEvent(
              effectiveRunId,
              eventData as RunCreatedEventRequest['eventData'],
              effectiveSpecVersion,
              eventDoc,
            );
            result.run = run;
            break;
          }
          case 'step_created': {
            const { step } = await createStepFromEvent(
              effectiveRunId,
              correlationId as string,
              eventData as { stepName: string; input: unknown },
              eventDoc,
              guard,
            );
            result.step = step;
            break;
          }
          case 'hook_created': {
            const hookEventData = eventData as {
              token: string;
              metadata?: unknown;
              isWebhook?: boolean;
            };

            if (!correlationId) {
              console.error('[hook_created] Missing correlationId');
            }
            if (!hookEventData.token) {
              console.error('[hook_created] Missing token in eventData');
            }

            const { hook, conflictEvent } = await createHookFromEvent(
              effectiveRunId,
              correlationId as string,
              hookEventData,
              effectiveSpecVersion,
              eventDoc,
              guard,
            );
            if (conflictEvent) {
              result.event = stripEventDataRefs(conflictEvent, resolveData);
            } else {
              result.hook = hook;
            }
            break;
          }
          case 'hook_disposed': {
            await disposeHookFromEvent(
              effectiveRunId,
              correlationId as string,
              existingHookDoc as CosmosDoc,
              eventDoc,
              guard,
            );
            break;
          }
          case 'wait_created': {
            result.wait = await createWaitFromEvent(
              effectiveRunId,
              correlationId as string,
              eventData,
              effectiveSpecVersion,
              eventDoc,
              guard,
            );
            break;
          }
          case 'wait_completed': {
            result.wait = await completeWaitFromEvent(
              effectiveRunId,
              correlationId as string,
              eventDoc,
              guard,
            );
            break;
          }
          case 'run_started':
          case 'run_completed':
          case 'run_failed':
          case 'run_cancelled': {
            // Idempotency: run_started on an already running run is a replay;
            // return the run without appending a duplicate event.
            if (data.eventType === 'run_started' && currentRun?.status === 'running') {
              result.run = currentRun;
              break;
            }
            result.run = await updateRunFromEvent(
              effectiveRunId,
              data.eventType,
              eventData,
              eventDoc,
              guard,
            );
            break;
          }
          case 'step_started':
          case 'step_completed':
          case 'step_failed':
          case 'step_retrying': {
            result.step = await updateStepFromEvent(
              effectiveRunId,
              correlationId as string,
              data.eventType,
              eventData,
              eventDoc,
              guard,
            );
            break;
          }
          default: {
            // hook_received (and any future event-only types): store the
            // event; no entity mutation needed at the storage level. Still a
            // guarded batch so hook_received can advance the state marker
            // atomically with its own event.
            await commitEventDoc(eventDoc, effectiveRunId, guard);
            break;
          }
        }

        // Preload all events for run_started to reduce TTFB.
        // Ordered by eventId (monotonic ULID); createdAt has millisecond
        // precision, so concurrent events can tie and replay order would
        // become nondeterministic.
        if (data.eventType === 'run_started' && result.run) {
          const eventsQuery: SqlQuerySpec = {
            query:
              'SELECT * FROM c WHERE c.type = "event" AND c.runId = @runId ORDER BY c.eventId ASC',
            parameters: [{ name: '@runId', value: effectiveRunId }],
          };
          const { resources: eventDocs } = await withCosmosRetry(() =>
            container.items.query(eventsQuery, { partitionKey: effectiveRunId }).fetchAll(),
          );
          result.events = eventDocs.map((doc: Record<string, unknown>) =>
            stripEventDataRefs(deserializeEvent(doc), resolveData),
          );
          result.cursor = result.events.at(-1)?.eventId ?? null;
          result.hasMore = false;
        }

        // The runtime reads the per-run event ceiling from the run_started
        // response only, so it must also be present on the idempotent
        // already-running replay path above.
        if (data.eventType === 'run_started' && result.run) {
          result.maxEvents = maxEventsPerRun;
        }

        return result;
      },

      async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
        const doc = await readRunPartitionDoc(runId, `event:${runId}:${eventId}`);
        if (!doc) {
          throw new WorkflowWorldError(`Event not found: ${eventId}`, {
            status: 404,
          });
        }

        return stripEventDataRefs(deserializeEvent(doc), params?.resolveData ?? 'all');
      },

      async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
        const { runId } = params;
        const resolveData = params?.resolveData ?? 'all';
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';
        const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

        // Order and paginate by eventId (monotonic ULID). createdAt has
        // millisecond precision, so concurrent events can tie; replay order
        // would become nondeterministic and cursor pagination could skip
        // events sharing the boundary timestamp.
        const conditions: string[] = ['c.type = "event"', 'c.runId = @runId'];
        const parameters: { name: string; value: string | number }[] = [
          { name: '@runId', value: runId },
        ];

        if (params?.pagination?.cursor) {
          const op = sortOrder === 'asc' ? '>' : '<';
          conditions.push(`c.eventId ${op} @cursor`);
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.eventId ${orderDir} OFFSET 0 LIMIT @limit`,
          parameters: [...parameters, { name: '@limit', value: limit + 1 }],
        };

        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
        );

        const values = resources.slice(0, limit);
        const hasMore = resources.length > limit;

        return {
          data: values.map((doc: Record<string, unknown>) =>
            stripEventDataRefs(deserializeEvent(doc), resolveData),
          ),
          cursor:
            values.length > 0
              ? ((values[values.length - 1] as Record<string, unknown>).eventId as string)
              : null,
          hasMore,
        };
      },

      async listByCorrelationId(params) {
        const { correlationId, runId } = params;
        const resolveData = params?.resolveData ?? 'all';
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';
        const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

        // Order and paginate by eventId (monotonic ULID), see events.list.
        const conditions: string[] = ['c.type = "event"', 'c.correlationId = @correlationId'];
        const parameters: { name: string; value: string | number }[] = [
          { name: '@correlationId', value: correlationId },
        ];

        // A correlation id is only unique within its run, so an unscoped lookup
        // can return another run's events. When the caller supplies a run, push
        // the predicate into the query and into the partition key (the events
        // container is partitioned on /runId), which also turns the fan-out
        // into a single-partition read. Filtering after the limit + 1 fetch
        // would corrupt the cursor and hasMore, so it has to happen here.
        // Older callers omit runId and keep the previous cross-partition path.
        if (runId !== undefined) {
          conditions.push('c.runId = @runId');
          parameters.push({ name: '@runId', value: runId });
        }

        // Same cursor predicate events.list uses. Without it the cursor is
        // silently ignored and every page repeats the first one.
        if (params?.pagination?.cursor) {
          const op = sortOrder === 'asc' ? '>' : '<';
          conditions.push(`c.eventId ${op} @cursor`);
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.eventId ${orderDir} OFFSET 0 LIMIT @limit`,
          parameters: [...parameters, { name: '@limit', value: limit + 1 }],
        };

        const feedOptions: FeedOptions =
          runId !== undefined
            ? { maxItemCount: limit + 1, partitionKey: runId }
            : { maxItemCount: limit + 1 };

        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec, feedOptions).fetchAll(),
        );

        const values = resources.slice(0, limit);
        const hasMore = resources.length > limit;

        return {
          data: values.map((doc: Record<string, unknown>) =>
            stripEventDataRefs(deserializeEvent(doc), resolveData),
          ),
          cursor:
            values.length > 0
              ? ((values[values.length - 1] as Record<string, unknown>).eventId as string)
              : null,
          hasMore,
        };
      },
    },

    steps: {
      async get(runId: string | undefined, stepId: string, params?: GetStepParams) {
        if (runId) {
          const step = await getStep(runId, stepId);
          return filterData(step, params?.resolveData, ['input', 'output']);
        }

        // The contract allows omitting runId; fall back to a cross-partition
        // lookup by stepId.
        const querySpec: SqlQuerySpec = {
          query: 'SELECT * FROM c WHERE c.type = "step" AND c.stepId = @stepId',
          parameters: [{ name: '@stepId', value: stepId }],
        };
        const { resources } = await withCosmosRetry(() =>
          container.items.query(querySpec).fetchAll(),
        );
        if (resources.length === 0) {
          throw new WorkflowWorldError(`Step not found: ${stepId}`, { status: 404 });
        }
        const step = deserializeStep(resources[0]);
        return filterData(step, params?.resolveData, ['input', 'output']);
      },

      async list(
        params: ListWorkflowRunStepsParams,
      ): Promise<PaginatedResponse<Step | StepWithoutData>> {
        const { runId } = params;
        const limit = params?.pagination?.limit ?? 20;

        const conditions: string[] = ['c.type = "step"', 'c.runId = @runId'];
        const parameters: { name: string; value: string | number }[] = [
          { name: '@runId', value: runId },
        ];

        // Order and paginate by stepId; createdAt has millisecond precision,
        // so cursor pagination on it can skip steps sharing the boundary
        // timestamp (matches the postgres reference).
        if (params?.pagination?.cursor) {
          conditions.push('c.stepId < @cursor');
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.stepId DESC OFFSET 0 LIMIT @limit`,
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
              ? ((values[values.length - 1] as Record<string, unknown>).stepId as string)
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
          throw new HookNotFoundError(hookId);
        }

        const hook = deserializeHook(resources[0]);
        const resolveData = params?.resolveData ?? 'all';
        return filterHookData(hook, resolveData);
      },

      async getByToken(token: string, params?: GetHookParams) {
        const resource = await readHookTokenDoc(token);

        if (!resource) {
          throw new HookNotFoundError(token);
        }

        const hook = deserializeHook(resource);
        const resolveData = params?.resolveData ?? 'all';
        return filterHookData(hook, resolveData);
      },

      async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
        if (!params.runId) {
          throw new WorkflowWorldError('runId is required for listing hooks', {
            status: 400,
          });
        }
        const runId = params.runId;
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params?.pagination?.sortOrder ?? 'asc';
        const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

        const conditions: string[] = ['c.type = "hook"', 'c.runId = @runId'];
        const parameters: { name: string; value: string | number }[] = [
          { name: '@runId', value: runId },
        ];

        // Order and paginate by hookId; createdAt has millisecond precision,
        // so cursor pagination on it can skip hooks sharing the boundary
        // timestamp (matches the postgres reference).
        if (params?.pagination?.cursor) {
          const op = sortOrder === 'asc' ? '>' : '<';
          conditions.push(`c.hookId ${op} @cursor`);
          parameters.push({ name: '@cursor', value: params.pagination.cursor });
        }

        const querySpec: SqlQuerySpec = {
          query: `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.hookId ${orderDir} OFFSET 0 LIMIT @limit`,
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
              ? ((values[values.length - 1] as Record<string, unknown>).hookId as string)
              : null,
          hasMore,
        };
      },
    },
  };
}
