import createPostgres from 'postgres';
import type { World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createQueue, type QStashConfig } from './queue.js';
import * as schema from './schema.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface PostgresUpstashWorldConfig {
  /**
   * PostgreSQL database connection string
   * Works with any PostgreSQL provider: Neon, Supabase, AWS RDS, etc.
   * Example: postgresql://user:pass@host:5432/dbname
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

export function createPostgresUpstashWorld(
  config: PostgresUpstashWorldConfig = {
    databaseUrl:
      process.env.DATABASE_URL ||
      'postgresql://localhost:5432/postgres_upstash_test',
    qstash: {
      token: process.env.QSTASH_TOKEN || '',
      targetUrl: process.env.QSTASH_URL || 'http://localhost:8080',
    },
  }
): World {
  const {
    databaseUrl,
    qstash,
    deploymentId = 'postgres-upstash-default',
    ownerId = '',
    projectId = '',
    environment = process.env.NODE_ENV || 'development',
  } = config;

  // Create PostgreSQL client using standard wire protocol
  const postgres = createPostgres(databaseUrl);
  const db = drizzle(postgres, { schema });

  // Create world components
  const storage = createStorage(db, deploymentId, {
    ownerId,
    projectId,
    environment,
  });
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
export { createPostgresUpstashWorld as createWorld };
