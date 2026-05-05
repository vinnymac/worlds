import mysql from 'mysql2/promise';
import type { World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/mysql2';
import { createQueue, type QStashConfig } from './queue.js';
import * as schema from './schema.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface MysqlUpstashWorldConfig {
  /**
   * MySQL database connection string
   * Works with any MySQL provider: PlanetScale, AWS RDS, Aiven, etc.
   * Example: mysql://user:pass@host:3306/dbname
   */
  databaseUrl: string;

  /**
   * Upstash QStash configuration
   */
  qstash: QStashConfig;

  /**
   * Optional deployment ID for tracking
   */
  deploymentId?: string;

  /**
   * Optional owner ID for hook tracking
   */
  ownerId?: string;

  /**
   * Optional project ID for hook tracking
   */
  projectId?: string;

  /**
   * Optional environment for hook tracking (defaults to NODE_ENV or 'development')
   */
  environment?: string;
}

export function createMysqlUpstashWorld(
  config: MysqlUpstashWorldConfig = {
    databaseUrl: process.env.DATABASE_URL || 'mysql://root:root@localhost:3306/mysql_upstash_test',
    qstash: {
      token: process.env.QSTASH_TOKEN || '',
      targetUrl: process.env.QSTASH_URL || 'http://localhost:8080',
    },
  },
): World {
  const { databaseUrl, qstash, deploymentId = 'mysql-upstash-default' } = config;

  // Create MySQL connection pool
  const pool = mysql.createPool(databaseUrl);
  const db = drizzle(pool, { schema, mode: 'default' });

  // Create world components
  const storage = createStorage(db);
  const queue = createQueue(qstash, deploymentId);
  const streamer = createStreamer(db);

  return {
    ...storage,
    ...queue,
    ...streamer,
  };
}

export type { QStashConfig };
export { schema };

// Re-export as createWorld for @workflow/core compatibility
export { createMysqlUpstashWorld as createWorld };
