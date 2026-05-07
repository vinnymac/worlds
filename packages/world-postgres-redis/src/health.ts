import type { ComponentHealth, HealthCheckResult } from '@fantasticfour/utils';
import { timeOperation } from '@fantasticfour/utils';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Drizzle } from './drizzle/index.js';
import type { OutboxRelay } from './outbox.js';

export interface PostgresRedisHealthResult extends HealthCheckResult {
  components: HealthCheckResult['components'] & {
    outbox: ComponentHealth & { pending: number; oldestPendingAgeMs: number | null };
  };
}

/**
 * Creates a health check function that pings both Postgres and Redis,
 * and reports outbox status.
 */
export function createHealthCheck(
  drizzle: Drizzle,
  redis: Redis,
  outboxRelay: OutboxRelay,
): () => Promise<PostgresRedisHealthResult> {
  return async function getHealth(): Promise<PostgresRedisHealthResult> {
    // Check Postgres
    const pg = await timeOperation(async () => {
      await drizzle.execute(sql`SELECT 1`);
      return true;
    });
    const pgHealth: ComponentHealth = {
      healthy: pg.error === undefined,
      latencyMs: pg.latencyMs,
      error: pg.error,
    };

    // Check Redis
    const rd = await timeOperation(async () => {
      await redis.ping();
      return true;
    });
    const redisHealth: ComponentHealth = {
      healthy: rd.error === undefined,
      latencyMs: rd.latencyMs,
      error: rd.error,
    };

    // Check outbox
    const [pending, oldestAge] = await Promise.all([
      outboxRelay.getPendingCount(),
      outboxRelay.getOldestPendingAgeMs(),
    ]);
    const outboxHealth: ComponentHealth & { pending: number; oldestPendingAgeMs: number | null } = {
      healthy: pending < 1000,
      pending,
      oldestPendingAgeMs: oldestAge,
    };

    const allHealthy = pgHealth.healthy && redisHealth.healthy && outboxHealth.healthy;

    return {
      healthy: allHealthy,
      components: {
        storage: pgHealth,
        queue: redisHealth,
        streamer: pgHealth, // Streamer uses Postgres, same health as storage
        outbox: outboxHealth,
      },
    };
  };
}
