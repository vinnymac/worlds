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
   * When enabled, the generated `messageId` is passed as the deduplication ID,
   * providing free idempotency within QStash's 90-day dedup window.
   * @default true
   * @see https://upstash.com/docs/qstash/features/deduplication
   */
  enableDeduplication?: boolean;
}
