import mysql from 'mysql2/promise';
import type { World } from '@workflow/world';
import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import { createQueue, type MysqlQueueConfig } from './queue.js';
import * as schema from './schema.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface MysqlWorldConfig {
  /**
   * MySQL database connection string
   * Works with any MySQL 8.0+ provider: PlanetScale, AWS RDS, Aiven, etc.
   * Example: mysql://user:pass@host:3306/dbname
   */
  databaseUrl: string;

  /**
   * Optional deployment ID for tracking
   */
  deploymentId?: string;

  /**
   * Queue configuration options
   */
  queue?: MysqlQueueConfig;

  /**
   * MySQL connection pool size (default: 25)
   * Recommendation: 2x workers + 5 buffer
   */
  connectionLimit?: number;

  /**
   * Per-run event ceiling reported to the runtime on `run_started`
   * (`EventResult.maxEvents`). The runtime fails a runaway run with
   * `MAX_EVENTS_EXCEEDED` once its replay log reaches this many events.
   * Defaults to `WORKFLOW_MAX_EVENTS`, else 25000.
   */
  maxEventsPerRun?: number;
}

export function createMysqlWorld(
  config: MysqlWorldConfig = {
    databaseUrl: process.env.DATABASE_URL || 'mysql://root:root@localhost:3306/mysql_test',
  },
): World & { start(): Promise<void>; stop(): void; close(): Promise<void> } {
  const { databaseUrl, queue: queueConfig = {}, connectionLimit = 25, maxEventsPerRun } = config;

  // Create MySQL connection pool
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit,
    waitForConnections: true,
  });
  const db = drizzle(pool, { schema, mode: 'default' });

  // Create world components
  const storage = createStorage(db, { maxEventsPerRun });
  const queue = createQueue(db, queueConfig);
  const streamer = createStreamer(db);

  return {
    // Declaring SPEC_VERSION_CURRENT enables the resilient-start path:
    // runs are created at the current spec version and queue messages carry
    // runInput, which requires the binary-safe tagged-JSON queue transport.
    specVersion: SPEC_VERSION_CURRENT,
    ...storage,
    ...queue,
    ...streamer,
    async start() {
      await queue.start();
      await reenqueueActiveRuns(storage.runs, queue.queue, 'world-mysql');
    },
    stop() {
      queue.stop();
    },
    async close() {
      queue.stop();
      await pool.end();
    },
  };
}

export type { MysqlQueueConfig };
export type { QueueMetrics } from './metrics.js';
export { metrics } from './metrics.js';
export { schema };

// Re-export as createWorld for @workflow/core compatibility
export { createMysqlWorld as createWorld };
