export interface UpstashWorldConfig {
  /**
   * Upstash Redis REST URL
   * @default process.env.UPSTASH_REDIS_REST_URL
   */
  redisUrl?: string;

  /**
   * Upstash Redis REST token
   * @default process.env.UPSTASH_REDIS_REST_TOKEN
   */
  redisToken?: string;

  /**
   * QStash token for authentication
   * @default process.env.QSTASH_TOKEN
   */
  qstashToken?: string;

  /**
   * Target URL for QStash webhooks
   * @default process.env.QSTASH_TARGET_URL
   */
  qstashTargetUrl?: string;

  /**
   * Redis key prefix for all workflow data
   * @default 'workflow:'
   */
  keyPrefix?: string;

  /**
   * QStash current signing key for signature verification on incoming deliveries.
   * When provided alongside nextSigningKey, the queue handler will reject
   * unsigned or improperly signed requests.
   * @default process.env.QSTASH_CURRENT_SIGNING_KEY
   * @see https://upstash.com/docs/qstash/howto/signing
   */
  qstashCurrentSigningKey?: string;

  /**
   * QStash next signing key for signature verification (supports key rotation).
   * @default process.env.QSTASH_NEXT_SIGNING_KEY
   * @see https://upstash.com/docs/qstash/howto/signing
   */
  qstashNextSigningKey?: string;

  /**
   * Enable QStash deduplication via `deduplicationId` on publish.
   * When enabled, the caller-provided `idempotencyKey` (sent by the workflow
   * runtime on every step enqueue) is passed as the deduplication ID, so
   * replayed enqueues of the same logical dispatch are collapsed within
   * QStash's 90-day dedup window.
   * @default true
   * @see https://upstash.com/docs/qstash/features/deduplication
   */
  enableDeduplication?: boolean;

  /**
   * Number of times QStash redelivers a message whose handler responds with a
   * status outside 200-299 (a hard failure). QStash's own default is small (3
   * on the free plan), well below core's retry budget: core allows up to 48
   * total deliveries (`MAX_QUEUE_DELIVERIES`) before marking a run failed.
   * Defaults to 47 retries (48 total deliveries) so QStash's redelivery budget
   * matches core's expectation. QStash clamps this to your plan's maximum.
   * @default 47
   * @see https://upstash.com/docs/qstash/features/retry
   */
  qstashRetries?: number;

  /** Maximum events a run may accumulate, reported as `EventResult.maxEvents`.
   * @default process.env.WORKFLOW_MAX_EVENTS || 25_000 */
  maxEventsPerRun?: number;

  /** Queue transport. `'qstash'` (default) publishes via hosted QStash;
   * `'loopback'` delivers in-process by POSTing the QStash wire body straight
   * to the target app's flow/step routes (for tests and local development).
   * Also selectable via `WORKFLOW_UPSTASH_QUEUE_MODE=loopback`. */
  queueMode?: 'qstash' | 'loopback';

  /** Max concurrent in-flight deliveries for the `'loopback'` queue transport
   * (ignored in `'qstash'` mode, where Upstash's hosted service throttles
   * delivery rate through real network round trips). Loopback self-POSTs
   * have no such limit: an immediate `{ timeoutSeconds: 0 }` retry storm can
   * fire unboundedly many concurrent requests at the harness server,
   * saturating the storage backend and starving the very deliveries that
   * would let the run converge. Mirrors world-redis/world-nats-jetstream's
   * default worker-pool concurrency.
   * @default 10 */
  loopbackConcurrency?: number;

  /** TTL (seconds) on creation-event claim keys, the SETNX arbiters that
   * dedup entity-creating events. Claims are pure overhead once a run is
   * terminal, and nothing else deletes them, so the TTL bounds billable
   * growth. Duplicates race within delivery windows (seconds to minutes),
   * making a month-long TTL a wide safety margin. `0` retains claims
   * forever.
   * @default process.env.WORKFLOW_UPSTASH_CLAIM_TTL_SECONDS || 2_592_000 (30 days) */
  claimTtlSeconds?: number;
}
