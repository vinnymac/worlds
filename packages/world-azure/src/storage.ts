import type { Container, JSONObject, OperationInput, SqlQuerySpec } from '@azure/cosmos';
import { BulkOperationType } from '@azure/cosmos';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type {
  AttributeChange,
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventResult,
  GetEventParams,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsByCorrelationIdParams,
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
  applyAttributeChanges,
  EventSchema,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  HookSchema,
  isChildEntityCreationEvent,
  isHookEventRequiringExistence,
  isLegacySpecVersion,
  isStepEventType,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  stripEventDataRefs,
  validateAttributeChanges,
  WaitSchema,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { encodeCbor, decodeCbor } from './cbor.js';
import {
  assertBatchCommitted,
  BatchOperationError,
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
type DocType = 'run' | 'event' | 'step' | 'hook' | 'wait' | 'attrclaim';

type CosmosDoc = Record<string, unknown>;

/**
 * Maximum optimistic-concurrency retries for etag-guarded entity transitions.
 */
const MAX_TRANSITION_ATTEMPTS = 5;

/** Maximum retries for a contended event slot. Each retry re-reads the log's
 * tail, so this only trips under sustained same-run write pressure. */
const MAX_SLOT_ATTEMPTS = 16;

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

/** Event document fields minus identity; the slot allocator assigns the id. */
interface EventBody {
  runId: string;
  eventType: string;
  correlationId?: string;
  /** CBOR-encoded eventData, omitted when the event stores none. */
  eventData?: Uint8Array;
  specVersion: number;
  createdAt: string;
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

  /** Execute a same-partition transactional batch with 429 retry. All event +
   * entity mutations go through here. */
  async function commitBatch(operations: OperationInput[], partitionKey: string) {
    return withCosmosRetry(async () => {
      // batch() resolves even when the transaction was rejected, so the
      // per-operation statuses have to be inspected explicitly.
      const response = await container.items.batch(operations, partitionKey);
      assertBatchCommitted(response);
      return response;
    });
  }

  /** Build the full event document for a slot-numbered id. */
  function eventDocAt(body: EventBody, eventId: string): CosmosDoc {
    return {
      id: `event:${body.runId}:${eventId}`,
      type: 'event' as DocType,
      runId: body.runId,
      eventId,
      eventType: body.eventType,
      specVersion: body.specVersion,
      createdAt: body.createdAt,
      ...(body.correlationId !== undefined && { correlationId: body.correlationId }),
      ...(body.eventData !== undefined && { eventData: body.eventData }),
    };
  }

  /** Next free slot of a run's log: the stored maximum plus one. Slot ids are
   * fixed-width decimals, so the lexicographic maximum is the positional one. */
  async function nextEventSlot(runId: string): Promise<number> {
    const querySpec: SqlQuerySpec = {
      query:
        'SELECT TOP 1 c.eventId FROM c WHERE c.type = "event" AND c.runId = @runId ' +
        'ORDER BY c.eventId DESC',
      parameters: [{ name: '@runId', value: runId }],
    };
    const { resources } = await withCosmosRetry(() =>
      container.items.query<{ eventId: string }>(querySpec, { partitionKey: runId }).fetchAll(),
    );
    const top = resources[0]?.eventId;
    if (top === undefined) {
      return FIRST_EVENT_SLOT;
    }
    const slot = eventIdToSlot(top);
    if (slot === null) {
      throw new WorkflowWorldError(
        `Run "${runId}" holds a non-slot event id "${top}"; its log cannot be extended`,
        { status: 500 },
      );
    }
    return slot + 1;
  }

  /**
   * Commit an event (plus same-partition entity operations) at the next free
   * slot. The slot is proposed from the store's current maximum and taken by
   * the batch Create of the slot-keyed document: Cosmos rejects a duplicate id
   * within the partition, so the Create is the conditional write that settles
   * a race at the commit. A loser re-reads the maximum, which the winner has
   * advanced, and retries at the new tail (the bump). Entity-operation
   * failures propagate to the caller for classification; the event Create is
   * always operation 0.
   */
  async function commitEventAtNextSlot(
    body: EventBody,
    extraOps: (eventDoc: CosmosDoc) => OperationInput[] = () => [],
  ): Promise<CosmosDoc> {
    for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt++) {
      const slot = await nextEventSlot(body.runId);
      const eventDoc = eventDocAt(body, slotToEventId(slot));
      try {
        await commitBatch(
          [
            { operationType: BulkOperationType.Create, resourceBody: toResourceBody(eventDoc) },
            ...extraOps(eventDoc),
          ],
          body.runId,
        );
        return eventDoc;
      } catch (error: unknown) {
        if (error instanceof BatchOperationError && error.index === 0 && error.code === 409) {
          continue;
        }
        if (isWrappedBatchError(error) && !(error instanceof BatchOperationError)) {
          // Transport-wrapped batch failure with no per-operation status:
          // an occupied slot means this writer lost the race.
          const taken = await readRunPartitionDoc(body.runId, eventDoc.id as string);
          if (taken) {
            continue;
          }
        }
        throw error;
      }
    }
    throw new WorkflowWorldError(
      `Event slot contention on run "${body.runId}" exceeded ${MAX_SLOT_ATTEMPTS} attempts`,
      { status: 500 },
    );
  }

  /** Parse a committed event document into the contract Event. */
  function toEvent(eventDoc: CosmosDoc, resolveData: ResolveData): Event {
    return stripEventDataRefs(EventSchema.parse(compact(deserializeEvent(eventDoc))), resolveData);
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

  /** Build a fresh run document from run_created / bootstrap event data. */
  function buildRunDoc(
    runId: string,
    data: RunCreatedEventRequest['eventData'],
    specVersion: number,
    now: Date,
  ): CosmosDoc {
    validateAttributeChanges(
      Object.entries(data.attributes ?? {}).map(([key, value]) => ({ key, value })),
      { allowReservedAttributes: data.allowReservedAttributes === true },
    );
    return {
      id: `run:${runId}`,
      type: 'run' as DocType,
      runId,
      workflowName: data.workflowName,
      specVersion,
      status: 'pending',
      input: encodeCbor(data.input),
      executionContext: data.executionContext as Record<string, unknown> | undefined,
      deploymentId: data.deploymentId,
      attributes: data.attributes ?? {},
      ...(data.encryptionPublicKey !== undefined && {
        encryptionPublicKey: data.encryptionPublicKey,
      }),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  /**
   * Internal: create a run entity (called from events.create for run_created
   * and the resilient-start bootstrap). The run_created event and the run
   * document commit in one same-partition transactional batch, with the slot
   * allocated at that commit.
   */
  async function createRunWithEvent(
    runId: string,
    data: RunCreatedEventRequest['eventData'],
    specVersion: number,
    body: EventBody,
  ): Promise<{ run: WorkflowRun; eventDoc: CosmosDoc }> {
    const run = buildRunDoc(runId, data, specVersion, new Date(body.createdAt));

    let eventDoc: CosmosDoc;
    try {
      eventDoc = await commitEventAtNextSlot(body, () => [
        { operationType: BulkOperationType.Create, resourceBody: toResourceBody(run) },
      ]);
    } catch (error: unknown) {
      // Classify by re-reading the entity: if the run exists, this was a
      // duplicate/concurrent run_created. The runtime swallows
      // EntityConflictError on the raced start() path.
      if (isConflictError(error) || isWrappedBatchError(error)) {
        const existing = await getRunDoc(runId);
        if (existing) {
          throw new EntityConflictError(`Workflow run "${runId}" already exists`);
        }
      }
      throw error;
    }
    return { run: deserializeRun(run), eventDoc };
  }

  /**
   * Internal: transition a run entity (called from events.create for
   * run_started/run_completed/run_failed/run_cancelled).
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
    body: EventBody,
  ): Promise<{ run: WorkflowRun; eventDoc?: CosmosDoc }> {
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
          return { run: deserializeRun(doc) };
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
          // WorkflowRun carries the machine-readable code top-level too.
          if (typeof eventData?.errorCode === 'string') {
            doc.errorCode = eventData.errorCode;
          }
          break;
        }
        case 'run_cancelled': {
          doc.status = 'cancelled';
          doc.completedAt = now.toISOString();
          break;
        }
      }

      let eventDoc: CosmosDoc;
      try {
        eventDoc = await commitEventAtNextSlot(body, () => [
          {
            operationType: BulkOperationType.Replace,
            id: doc.id as string,
            ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
            resourceBody: toResourceBody(doc),
          },
        ]);
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

      return { run: deserializeRun(doc), eventDoc };
    }

    throw lastError ?? new WorkflowWorldError(`Failed to transition run "${runId}"`);
  }

  /**
   * Internal: create a step entity (called from events.create for
   * step_created and the lazy step_started create). The creation event and
   * the step document commit in one transactional batch.
   */
  async function createStepFromEvent(
    runId: string,
    stepId: string,
    data: { stepName: string; input: unknown },
    specVersion: number,
    body: EventBody,
  ): Promise<{ step: Step; eventDoc: CosmosDoc }> {
    const now = new Date(body.createdAt);
    const step: CosmosDoc = {
      id: `step:${runId}:${stepId}`,
      type: 'step' as DocType,
      runId,
      stepId,
      stepName: data.stepName,
      status: 'pending',
      input: encodeCbor(data.input),
      attempt: 0,
      specVersion,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    let eventDoc: CosmosDoc;
    try {
      eventDoc = await commitEventAtNextSlot(body, () => [
        { operationType: BulkOperationType.Create, resourceBody: toResourceBody(step) },
      ]);
    } catch (error: unknown) {
      // Batch errors are opaque, so re-read to classify. Duplicate
      // step_created -> EntityConflictError, which the runtime's
      // concurrent-replay catch path swallows (and the owned-inline path
      // maps to `skipped`).
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
    return { step: deserializeStep(step), eventDoc };
  }

  /**
   * Internal: transition a step entity (called from events.create for
   * step_started/step_completed/step_failed/step_retrying).
   *
   * Same atomic event + etag-guarded replace pattern as updateRunFromEvent.
   */
  async function updateStepFromEvent(
    runId: string,
    stepId: string,
    eventType: string,
    eventData: Record<string, unknown> | undefined,
    body: EventBody,
  ): Promise<{ step: Step; eventDoc: CosmosDoc }> {
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
          doc.attempt = (typeof doc.attempt === 'number' ? doc.attempt : 0) + 1;
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
          break;
        }
      }

      let eventDoc: CosmosDoc;
      try {
        eventDoc = await commitEventAtNextSlot(body, () => [
          {
            operationType: BulkOperationType.Replace,
            id: doc.id as string,
            ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
            resourceBody: toResourceBody(doc),
          },
        ]);
      } catch (error: unknown) {
        if (isWrappedBatchError(error) || isPreconditionFailedError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return { step: deserializeStep(doc), eventDoc };
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
    body: EventBody,
  ): Promise<{ wait: Wait; eventDoc: CosmosDoc }> {
    const now = new Date(body.createdAt);
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

    let eventDoc: CosmosDoc;
    try {
      eventDoc = await commitEventAtNextSlot(body, () => [
        { operationType: BulkOperationType.Create, resourceBody: toResourceBody(waitDoc) },
      ]);
    } catch (error: unknown) {
      if (isConflictError(error) || isWrappedBatchError(error)) {
        const existing = await readRunPartitionDoc(runId, `wait:${runId}:${correlationId}`);
        if (existing) {
          throw new EntityConflictError(`Wait "${correlationId}" already exists`);
        }
      }
      throw error;
    }
    return { wait: deserializeWait(waitDoc), eventDoc };
  }

  /**
   * Internal: transition a wait entity to completed (called from events.create
   * for wait_completed). Duplicate completions -> EntityConflictError so
   * at-least-once wake-up deliveries never append duplicate wait events.
   */
  async function completeWaitFromEvent(
    runId: string,
    correlationId: string,
    body: EventBody,
  ): Promise<{ wait: Wait; eventDoc: CosmosDoc }> {
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

      let eventDoc: CosmosDoc;
      try {
        eventDoc = await commitEventAtNextSlot(body, () => [
          {
            operationType: BulkOperationType.Replace,
            id: doc.id as string,
            ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
            resourceBody: toResourceBody(doc),
          },
        ]);
      } catch (error: unknown) {
        if (isWrappedBatchError(error) || isPreconditionFailedError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return { wait: deserializeWait(doc), eventDoc };
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
    body: EventBody,
  ): Promise<{ eventDoc: CosmosDoc }> {
    let eventDoc: CosmosDoc;
    try {
      eventDoc = await commitEventAtNextSlot(body, () => [
        { operationType: BulkOperationType.Delete, id: hookDoc.id as string },
      ]);
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
    return { eventDoc };
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
    body: EventBody,
  ): Promise<{ hook?: Hook; conflictEventDoc?: CosmosDoc; eventDoc?: CosmosDoc }> {
    const now = new Date(body.createdAt);

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
    ): Promise<{ hook?: Hook; conflictEventDoc?: CosmosDoc; eventDoc?: CosmosDoc }> {
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
        const eventDoc = await commitEventAtNextSlot(body);
        return { hook: deserializeHook(claim), eventDoc };
      }

      // Cross-run conflict: a different (runId, hookId) holds this token.
      // Store a hook_conflict event instead of throwing.
      const conflictEventDoc = await commitEventAtNextSlot({
        runId,
        eventType: 'hook_conflict',
        correlationId: hookId,
        eventData: encodeCbor({
          token: data.token,
          conflictingRunId: claim.runId as string,
        }),
        specVersion,
        createdAt: body.createdAt,
      });
      return { conflictEventDoc };
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
    const eventDoc = await commitEventAtNextSlot(body);

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
    return { hook: parsed, eventDoc };
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

  /** Load a run's full event log for the run_started preload, in slot order. */
  async function preloadAllEvents(
    runId: string,
    resolveData: ResolveData,
  ): Promise<{ events: Event[]; cursor: string | null; hasMore: false }> {
    const eventsQuery: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE c.type = "event" AND c.runId = @runId ORDER BY c.eventId ASC',
      parameters: [{ name: '@runId', value: runId }],
    };
    const { resources } = await withCosmosRetry(() =>
      container.items.query(eventsQuery, { partitionKey: runId }).fetchAll(),
    );
    const events = resources.map((doc: Record<string, unknown>) =>
      stripEventDataRefs(deserializeEvent(doc), resolveData),
    );
    return { events, cursor: events.at(-1)?.eventId ?? null, hasMore: false };
  }

  /** Read one page of a run's event log, `events.list` semantics. */
  async function listEventsImpl(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
    const { runId } = params;
    const resolveData = params?.resolveData ?? 'all';
    const limit = params?.pagination?.limit ?? 100;
    const sortOrder = params.pagination?.sortOrder || 'asc';
    const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

    // Order and paginate by eventId: slot ids are fixed-width decimals, so
    // lexicographic order is positional order, and the cursor predicate can
    // never skip events sharing a boundary timestamp.
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
  }

  /**
   * The report half of bump-and-report: when the committed slot exceeds
   * `eventCount + 1`, return the events occupying the skipped span so the
   * writer learns its snapshot was stale without the write being rejected.
   * `cursor` stays null: the report is a lower bound, not a read position.
   */
  async function reportSkippedSlots(
    result: EventResult,
    askedFor: number,
    resolveData: ResolveData,
  ): Promise<EventResult> {
    if (!result.event) {
      return result;
    }
    const committedSlot = eventIdToSlot(result.event.eventId);
    if (
      committedSlot === null ||
      askedFor < FIRST_EVENT_SLOT - 1 ||
      committedSlot <= askedFor + 1
    ) {
      return result;
    }
    const span = committedSlot - askedFor - 1;
    const runId = result.event.runId;
    const querySpec: SqlQuerySpec = {
      query:
        'SELECT * FROM c WHERE c.type = "event" AND c.runId = @runId ' +
        'AND c.eventId >= @from AND c.eventId <= @to ORDER BY c.eventId ASC',
      parameters: [
        { name: '@runId', value: runId },
        { name: '@from', value: slotToEventId(askedFor + 1) },
        { name: '@to', value: slotToEventId(committedSlot - 1) },
      ],
    };
    const { resources } = await withCosmosRetry(() =>
      container.items.query(querySpec, { partitionKey: runId }).fetchAll(),
    );
    const events = resources.map((doc: Record<string, unknown>) =>
      stripEventDataRefs(deserializeEvent(doc), resolveData),
    );
    return {
      ...result,
      events,
      cursor: null,
      hasMore: events.length < span,
    };
  }

  /**
   * Handle events for legacy runs (pre-event-sourcing, specVersion <= 1).
   * Legacy runs keep ULID event ids so the log's identity scheme stays
   * uniform within one run.
   */
  async function handleLegacyEvent(
    runId: string,
    data: CreateEventRequest | RunCreatedEventRequest,
    resolveData: ResolveData,
  ): Promise<EventResult> {
    switch (data.eventType) {
      case 'run_cancelled': {
        // Legacy: no event storage; transition the run entity directly.
        let lastError: unknown;
        for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
          const doc = await getRunDoc(runId);
          if (!doc) return {};
          if (doc.status === 'cancelled') {
            return { run: filterData(deserializeRun(doc), resolveData, ['input', 'output']) };
          }
          const now = new Date();
          doc.status = 'cancelled';
          doc.completedAt = now.toISOString();
          doc.updatedAt = now.toISOString();
          try {
            await commitBatch(
              [
                {
                  operationType: BulkOperationType.Replace,
                  id: doc.id as string,
                  ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
                  resourceBody: toResourceBody(doc),
                },
              ],
              runId,
            );
          } catch (error: unknown) {
            if (isWrappedBatchError(error) || isPreconditionFailedError(error)) {
              lastError = error;
              continue;
            }
            throw error;
          }
          await cleanupRunScopedEntities(runId);
          return { run: filterData(deserializeRun(doc), resolveData, ['input', 'output']) };
        }
        throw lastError ?? new WorkflowWorldError(`Failed to cancel legacy run "${runId}"`);
      }

      case 'wait_completed':
      case 'hook_received': {
        const eventId = `wevt_${ulid()}`;
        const now = new Date();
        const eventData =
          'eventData' in data ? (data.eventData as Record<string, unknown> | undefined) : undefined;
        const eventDoc: CosmosDoc = {
          id: `event:${runId}:${eventId}`,
          type: 'event' as DocType,
          runId,
          eventId,
          eventType: data.eventType,
          eventData: encodeCbor(eventData ?? {}),
          specVersion: SPEC_VERSION_CURRENT,
          createdAt: now.toISOString(),
          ...('correlationId' in data &&
            data.correlationId !== undefined && { correlationId: data.correlationId }),
        };
        await withCosmosRetry(() => container.items.create(eventDoc));
        return { event: toEvent(eventDoc, resolveData) };
      }

      default:
        throw new WorkflowWorldError(
          `Event type '${data.eventType}' not supported for legacy runs. ` +
            'Please upgrade @workflow packages.',
          { status: 400 },
        );
    }
  }

  async function createImpl(
    runId: string | null,
    data: RunCreatedEventRequest | CreateEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> {
    const now = new Date();
    const resolveData = params?.resolveData ?? 'all';

    // For run_created events, generate a runId if null
    const effectiveRunId =
      runId && runId !== '' ? runId : data.eventType === 'run_created' ? `wrun_${ulid()}` : '';
    if (!effectiveRunId) {
      throw new WorkflowWorldError(`runId is required for ${data.eventType} events`, {
        status: 400,
      });
    }

    const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    const correlationId = 'correlationId' in data ? data.correlationId : undefined;
    const eventData =
      'eventData' in data ? (data.eventData as Record<string, unknown> | undefined) : undefined;

    /** Event body for the main event of this create. */
    const body: EventBody = {
      runId: effectiveRunId,
      eventType: data.eventType,
      specVersion: effectiveSpecVersion,
      createdAt: now.toISOString(),
      ...(correlationId !== undefined && { correlationId }),
      // run_started stores no eventData (its payload only bootstraps the run).
      ...(data.eventType !== 'run_started' && { eventData: encodeCbor(eventData ?? {}) }),
    };

    // Entity creation: run_created writes the run and its creation event in
    // one batch; a duplicate throws EntityConflictError everywhere.
    if (data.eventType === 'run_created') {
      const { run, eventDoc } = await createRunWithEvent(
        effectiveRunId,
        data.eventData,
        effectiveSpecVersion,
        body,
      );
      return {
        event: toEvent(eventDoc, resolveData),
        run: filterData(run, resolveData, ['input', 'output']),
        maxEvents: maxEventsPerRun,
      };
    }

    let runDoc = await getRunDoc(effectiveRunId);

    // ============================================================
    // RESILIENT START: Bootstrap run from run_started eventData. The
    // synthetic run_created takes the earlier slot, so it replays first.
    // ============================================================
    if (data.eventType === 'run_started' && !runDoc && eventData) {
      const runInputData = eventData as RunCreatedEventRequest['eventData'];
      if (
        runInputData.deploymentId &&
        runInputData.workflowName &&
        runInputData.input !== undefined
      ) {
        try {
          await createRunWithEvent(effectiveRunId, runInputData, effectiveSpecVersion, {
            runId: effectiveRunId,
            eventType: 'run_created',
            specVersion: effectiveSpecVersion,
            createdAt: now.toISOString(),
            eventData: encodeCbor({
              deploymentId: runInputData.deploymentId,
              workflowName: runInputData.workflowName,
              input: runInputData.input,
              executionContext: runInputData.executionContext,
              ...(runInputData.attributes !== undefined && {
                attributes: runInputData.attributes,
              }),
              ...(runInputData.allowReservedAttributes !== undefined && {
                allowReservedAttributes: runInputData.allowReservedAttributes,
              }),
              ...(runInputData.encryptionPublicKey !== undefined && {
                encryptionPublicKey: runInputData.encryptionPublicKey,
              }),
            }),
          });
        } catch (error: unknown) {
          // A concurrent run_created won the race; the run exists, which is
          // all the bootstrap needs.
          if (!(error instanceof EntityConflictError)) {
            throw error;
          }
        }
        runDoc = await getRunDoc(effectiveRunId);
      }
    }

    // Match the first-party worlds: these events reject on a non-existent run
    // rather than persisting an orphan event.
    if (
      !runDoc &&
      (data.eventType === 'run_failed' ||
        data.eventType === 'attr_set' ||
        data.eventType === 'run_started')
    ) {
      throw new WorkflowRunNotFoundError(effectiveRunId);
    }

    // ============================================================
    // VERSION COMPATIBILITY: Check run spec version
    // ============================================================
    if (runDoc) {
      const runSpecVersion = runDoc.specVersion as number | undefined;
      if (requiresNewerWorld(runSpecVersion)) {
        throw new RunNotSupportedError(runSpecVersion as number, SPEC_VERSION_CURRENT);
      }
      if (isLegacySpecVersion(runSpecVersion)) {
        return handleLegacyEvent(effectiveRunId, data, resolveData);
      }
    }

    // Lazy step start: a step_started carrying step-creation data (stepName +
    // input) may arrive with no prior step_created and creates the step on
    // the fly, mirroring the resilient run_started path.
    const createsChildEntity = isChildEntityCreationEvent(data);
    const lazyStepStart = createsChildEntity && data.eventType === 'step_started';

    // ============================================================
    // VALIDATION: terminal-state and event-ordering guards. These run
    // BEFORE any write so rejected duplicates can never corrupt the log:
    // - RunExpiredError: run already terminal -> skip the message
    // - EntityConflictError: duplicate/terminal entity -> treat as an
    //   idempotent concurrent replay and continue
    // - TooEarlyError: step retryAfter not reached -> defer via queue
    // ============================================================
    const runStatus = runDoc?.status as string | undefined;
    const runIsTerminal = runStatus !== undefined && isTerminalWorkflowRunStatus(runStatus);
    if (runIsTerminal && runDoc) {
      // Idempotent operation: run_cancelled on an already cancelled run
      // records the event without re-transitioning the run.
      if (data.eventType === 'run_cancelled' && runStatus === 'cancelled') {
        const eventDoc = await commitEventAtNextSlot(body);
        return {
          event: toEvent(eventDoc, resolveData),
          run: filterData(deserializeRun(runDoc), resolveData, ['input', 'output']),
          maxEvents: maxEventsPerRun,
        };
      }
      // For run_started on terminal runs, use RunExpiredError so the runtime
      // knows to exit without retrying.
      if (data.eventType === 'run_started') {
        throw new RunExpiredError(
          `Workflow run "${effectiveRunId}" is already in terminal state "${runStatus}"`,
        );
      }
      if (isTerminalRunEventType(data.eventType)) {
        throw new EntityConflictError(`Cannot transition run from terminal state "${runStatus}"`);
      }
      if (createsChildEntity) {
        throw new EntityConflictError(
          `Cannot create new entities on run in terminal state "${runStatus}"`,
        );
      }
      if (data.eventType === 'attr_set') {
        throw new EntityConflictError(
          `Cannot set attributes on run in terminal state "${runStatus}"`,
        );
      }
    }

    // Step-related event validation (ordering and terminal state)
    let validatedStepDoc: CosmosDoc | undefined;
    const stepEventNeedsStep = isStepEventType(data.eventType) && data.eventType !== 'step_created';
    if (stepEventNeedsStep && correlationId) {
      validatedStepDoc = await getStepDoc(effectiveRunId, correlationId);
      if (!validatedStepDoc && !lazyStepStart) {
        throw new WorkflowWorldError(`Step not found: ${correlationId}`, { status: 404 });
      }
      // Lazy start exactly-once gate: a lazy step_started always CREATES the
      // step. An existing step means a concurrent handler won the create;
      // EntityConflictError maps to `skipped` in the runtime's executeStep.
      if (lazyStepStart && validatedStepDoc) {
        throw new EntityConflictError(`Step "${correlationId}" already created`);
      }
      if (validatedStepDoc) {
        const stepStatus = validatedStepDoc.status as string;
        if (isTerminalStepStatus(stepStatus)) {
          throw new EntityConflictError(`Cannot modify step in terminal state "${stepStatus}"`);
        }
        if (runIsTerminal && stepStatus !== 'running') {
          throw new RunExpiredError(
            `Cannot modify non-running step on run in terminal state "${runStatus}"`,
          );
        }
      }
    }

    // Event ordering: hook_received/hook_disposed require an existing hook.
    let existingHookDoc: CosmosDoc | undefined;
    if (isHookEventRequiringExistence(data.eventType) && correlationId) {
      existingHookDoc = await readRunPartitionDoc(
        effectiveRunId,
        `hook:${effectiveRunId}:${correlationId}`,
      );
      if (!existingHookDoc) {
        throw new HookNotFoundError(correlationId);
      }
    }

    // Entity side effects. All entity-bearing events commit the event
    // document and the entity mutation in one same-partition transactional
    // batch, with the slot taken at that commit.
    switch (data.eventType) {
      case 'step_created': {
        const { step, eventDoc } = await createStepFromEvent(
          effectiveRunId,
          correlationId as string,
          data.eventData,
          effectiveSpecVersion,
          body,
        );
        return { event: toEvent(eventDoc, resolveData), step };
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

        const { hook, conflictEventDoc, eventDoc } = await createHookFromEvent(
          effectiveRunId,
          correlationId as string,
          hookEventData,
          effectiveSpecVersion,
          body,
        );
        if (conflictEventDoc) {
          return { event: toEvent(conflictEventDoc, resolveData) };
        }
        return {
          ...(eventDoc && { event: toEvent(eventDoc, resolveData) }),
          hook,
        };
      }
      case 'hook_disposed': {
        const { eventDoc } = await disposeHookFromEvent(
          effectiveRunId,
          correlationId as string,
          existingHookDoc as CosmosDoc,
          body,
        );
        return { event: toEvent(eventDoc, resolveData) };
      }
      case 'wait_created': {
        const { wait, eventDoc } = await createWaitFromEvent(
          effectiveRunId,
          correlationId as string,
          eventData,
          effectiveSpecVersion,
          body,
        );
        return { event: toEvent(eventDoc, resolveData), wait };
      }
      case 'wait_completed': {
        const { wait, eventDoc } = await completeWaitFromEvent(
          effectiveRunId,
          correlationId as string,
          body,
        );
        return { event: toEvent(eventDoc, resolveData), wait };
      }
      case 'attr_set': {
        // Merge the changes onto the run entity, committed atomically with
        // the event. A workflow-writer attr_set with a correlationId carries
        // a claim document in the same batch, so a replayed event cannot
        // apply (or log) twice.
        const changes = data.eventData.changes;
        const needsClaim = data.eventData.writer.type === 'workflow' && correlationId !== undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
          const doc = await getRunDoc(effectiveRunId);
          if (!doc) {
            throw new WorkflowRunNotFoundError(effectiveRunId);
          }
          const existingAttributes = (doc.attributes ?? {}) as Record<string, string>;
          validateAttributeChanges(changes, {
            existingKeys: Object.keys(existingAttributes),
            allowReservedAttributes: data.eventData.allowReservedAttributes === true,
          });
          doc.attributes = applyAttributeChanges(existingAttributes, changes);
          doc.updatedAt = now.toISOString();
          try {
            const eventDoc = await commitEventAtNextSlot(body, () => [
              {
                operationType: BulkOperationType.Replace,
                id: doc.id as string,
                ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
                resourceBody: toResourceBody(doc),
              },
              ...(needsClaim
                ? [
                    {
                      operationType: BulkOperationType.Create,
                      resourceBody: toResourceBody({
                        id: `attrclaim:${effectiveRunId}:${correlationId}`,
                        type: 'attrclaim' as DocType,
                        runId: effectiveRunId,
                      }),
                    },
                  ]
                : []),
            ]);
            return {
              event: toEvent(eventDoc, resolveData),
              run: filterData(deserializeRun(doc), resolveData, ['input', 'output']),
            };
          } catch (error: unknown) {
            // The claim Create is the batch's last operation; its 409 means
            // this attr_set already applied on a previous delivery.
            if (
              error instanceof BatchOperationError &&
              error.index === (needsClaim ? 2 : -1) &&
              error.code === 409
            ) {
              throw new EntityConflictError(`Attribute event "${correlationId}" already exists`);
            }
            if (isWrappedBatchError(error) || isPreconditionFailedError(error)) {
              lastError = error;
              continue;
            }
            throw error;
          }
        }
        throw (
          lastError ??
          new WorkflowWorldError(`Concurrent update contention on run "${effectiveRunId}"`, {
            status: 500,
          })
        );
      }
      case 'run_started': {
        // Idempotency: run_started on an already running run is a replay;
        // return the run without appending a duplicate event. Core reads the
        // per-run event ceiling only from the run_started response, so it
        // must be present on this path too.
        if (runStatus === 'running' && runDoc) {
          const run = filterData(deserializeRun(runDoc), resolveData, [
            'input',
            'output',
          ]) as WorkflowRun;
          if (params?.skipPreload) {
            return { run, maxEvents: maxEventsPerRun };
          }
          const preloaded = await preloadAllEvents(effectiveRunId, resolveData);
          return {
            run,
            events: preloaded.events,
            cursor: preloaded.cursor,
            hasMore: preloaded.hasMore,
            maxEvents: maxEventsPerRun,
          };
        }
        const { run, eventDoc } = await updateRunFromEvent(
          effectiveRunId,
          data.eventType,
          eventData,
          body,
        );
        const filtered = filterData(run, resolveData, ['input', 'output']) as WorkflowRun;
        if (params?.skipPreload) {
          return {
            ...(eventDoc && { event: toEvent(eventDoc, resolveData) }),
            run: filtered,
            maxEvents: maxEventsPerRun,
          };
        }
        // Preload all events for run_started to reduce TTFB, in slot order.
        const preloaded = await preloadAllEvents(effectiveRunId, resolveData);
        return {
          ...(eventDoc && { event: toEvent(eventDoc, resolveData) }),
          run: filtered,
          events: preloaded.events,
          cursor: preloaded.cursor,
          hasMore: preloaded.hasMore,
          maxEvents: maxEventsPerRun,
        };
      }
      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled': {
        const { run, eventDoc } = await updateRunFromEvent(
          effectiveRunId,
          data.eventType,
          eventData,
          body,
        );
        return {
          ...(eventDoc && { event: toEvent(eventDoc, resolveData) }),
          run: filterData(run, resolveData, ['input', 'output']),
          maxEvents: maxEventsPerRun,
        };
      }
      case 'step_started': {
        let stepCreatedLazily = false;
        if (lazyStepStart && !validatedStepDoc) {
          // The lazy path creates the step (the batch Create is the
          // exactly-once ownership claim) plus a synthetic step_created
          // event at the prior slot.
          const lazyData = data.eventData as { stepName: string; input: unknown };
          await createStepFromEvent(
            effectiveRunId,
            correlationId as string,
            lazyData,
            effectiveSpecVersion,
            {
              runId: effectiveRunId,
              eventType: 'step_created',
              correlationId: correlationId as string,
              specVersion: effectiveSpecVersion,
              createdAt: now.toISOString(),
              eventData: encodeCbor({ stepName: lazyData.stepName, input: lazyData.input }),
            },
          );
          stepCreatedLazily = true;
        }
        const { step, eventDoc } = await updateStepFromEvent(
          effectiveRunId,
          correlationId as string,
          data.eventType,
          eventData,
          body,
        );
        return {
          event: toEvent(eventDoc, resolveData),
          step,
          ...(stepCreatedLazily ? { stepCreated: true as const } : {}),
        };
      }
      case 'step_completed':
      case 'step_failed':
      case 'step_retrying': {
        const { step, eventDoc } = await updateStepFromEvent(
          effectiveRunId,
          correlationId as string,
          data.eventType,
          eventData,
          body,
        );
        return { event: toEvent(eventDoc, resolveData), step };
      }
      default: {
        // hook_received (and any future event-only types): store the event;
        // no entity mutation needed at the storage level.
        const eventDoc = await commitEventAtNextSlot(body);
        return { event: toEvent(eventDoc, resolveData) };
      }
    }
  }

  const create = (async (
    runId: string | null,
    data: RunCreatedEventRequest | CreateEventRequest,
    params?: CreateEventParams,
  ): Promise<EventResult> => {
    const result = await createImpl(runId, data, params);
    const resolveData = params?.resolveData ?? 'all';

    // Inline-delta optimization: the delta of events strictly after
    // `sinceCursor`, exactly what `events.list` would return right now. It
    // wins over the skipped-slot report (a strict superset, and the only one
    // of the two that advances the caller's cursor), and applies to the
    // hook_conflict a claimed-token create commits instead.
    if (typeof params?.sinceCursor === 'string' && result.event) {
      const page = await listEventsImpl({
        runId: result.event.runId,
        pagination: { cursor: params.sinceCursor, sortOrder: 'asc' },
        resolveData,
      });
      return { ...result, events: page.data, cursor: page.cursor, hasMore: page.hasMore };
    }

    if (params?.eventCount !== undefined && result.event && result.events === undefined) {
      return reportSkippedSlots(result, params.eventCount, resolveData);
    }

    return result;
  }) as Storage['events']['create'];

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

      // Merge attribute changes onto the run entity via an etag-guarded
      // replace, returning the post-merge snapshot.
      async experimentalSetAttributes(
        runId: string,
        changes: AttributeChange[],
        options?: { allowReservedAttributes?: boolean },
      ) {
        let lastError: unknown;
        for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
          const doc = await getRunDoc(runId);
          if (!doc) {
            throw new WorkflowRunNotFoundError(runId);
          }
          const existingAttributes = (doc.attributes ?? {}) as Record<string, string>;
          validateAttributeChanges(changes, {
            existingKeys: Object.keys(existingAttributes),
            allowReservedAttributes: options?.allowReservedAttributes === true,
          });
          const attributes = applyAttributeChanges(existingAttributes, changes);
          doc.attributes = attributes;
          doc.updatedAt = new Date().toISOString();
          try {
            await commitBatch(
              [
                {
                  operationType: BulkOperationType.Replace,
                  id: doc.id as string,
                  ...(typeof doc._etag === 'string' && { ifMatch: doc._etag }),
                  resourceBody: toResourceBody(doc),
                },
              ],
              runId,
            );
          } catch (error: unknown) {
            if (isWrappedBatchError(error) || isPreconditionFailedError(error)) {
              lastError = error;
              continue;
            }
            throw error;
          }
          return { attributes };
        }
        throw (
          lastError ??
          new WorkflowWorldError(`Concurrent update contention on run "${runId}"`, {
            status: 500,
          })
        );
      },
    } as Storage['runs'],

    events: {
      create,

      async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
        const doc = await readRunPartitionDoc(runId, `event:${runId}:${eventId}`);
        if (!doc) {
          throw new WorkflowWorldError(`Event not found: ${eventId}`, {
            status: 404,
          });
        }

        return stripEventDataRefs(deserializeEvent(doc), params?.resolveData ?? 'all');
      },

      list: listEventsImpl,

      async listByCorrelationId(params: ListEventsByCorrelationIdParams) {
        const { correlationId, runId } = params;
        const resolveData = params?.resolveData ?? 'all';
        const limit = params?.pagination?.limit ?? 100;
        const sortOrder = params.pagination?.sortOrder || 'asc';
        const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';

        // A correlation id is only unique within its run, so the lookup is
        // always run-scoped: the predicate rides the partition key (the
        // container is partitioned on /runId), which also makes the
        // (runId, eventId) pagination cursor unambiguous.
        const conditions: string[] = [
          'c.type = "event"',
          'c.runId = @runId',
          'c.correlationId = @correlationId',
        ];
        const parameters: { name: string; value: string | number }[] = [
          { name: '@runId', value: runId },
          { name: '@correlationId', value: correlationId },
        ];

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

        const { resources } = await withCosmosRetry(() =>
          container.items
            .query(querySpec, { maxItemCount: limit + 1, partitionKey: runId })
            .fetchAll(),
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
      async get(runId: string, stepId: string, params?: GetStepParams) {
        const step = await getStep(runId, stepId);
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
