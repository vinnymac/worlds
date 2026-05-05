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
}
