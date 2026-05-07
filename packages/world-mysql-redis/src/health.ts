import type { HealthCheckResult } from '@fantasticfour/shared';
import { timeOperation } from '@fantasticfour/shared';
import { sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { Redis } from 'ioredis';
import type * as schema from './schema.js';
import { getOutboxStats } from './outbox.js';

type Drizzle = MySql2Database<typeof schema>;

export interface MysqlRedisHealthResult extends HealthCheckResult {
  metadata: {
    outbox: {
      pending: number;
      oldestPendingAgeMs: number | null;
    };
  };
}

/**
 * Perform a unified health check across MySQL and Redis.
 * Probes both backends with a simple operation and reports latency.
 * Also includes outbox stats for operational monitoring.
 */
export async function getHealth(db: Drizzle, redis: Redis): Promise<MysqlRedisHealthResult> {
  // Probe MySQL and Redis in parallel
  const [mysqlProbe, redisProbe] = await Promise.all([
    timeOperation(async () => {
      await db.execute(sql`SELECT 1`);
      return true;
    }),
    timeOperation(async () => {
      await redis.ping();
      return true;
    }),
  ]);

  // Get outbox stats (best-effort, don't fail the whole health check)
  let outboxStats = { pending: 0, oldestPendingAgeMs: null as number | null };
  try {
    outboxStats = await getOutboxStats(db);
  } catch {
    // If outbox table doesn't exist yet, that's fine
  }

  const mysqlHealthy = !mysqlProbe.error;
  const redisHealthy = !redisProbe.error;

  return {
    healthy: mysqlHealthy && redisHealthy,
    components: {
      storage: {
        healthy: mysqlHealthy,
        latencyMs: mysqlProbe.latencyMs,
        error: mysqlProbe.error,
      },
      queue: {
        healthy: redisHealthy,
        latencyMs: redisProbe.latencyMs,
        error: redisProbe.error,
      },
      streamer: {
        // Streamer uses the same MySQL connection as storage
        healthy: mysqlHealthy,
        latencyMs: mysqlProbe.latencyMs,
        error: mysqlProbe.error,
      },
    },
    metadata: {
      outbox: outboxStats,
    },
  };
}
