import { neon, neonConfig } from '@neondatabase/serverless';
import type { World } from '@workflow/world';
import { drizzle } from 'drizzle-orm/neon-http';
import { createQueue, type QStashConfig } from './queue.js';
import * as schema from './schema.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface NeonUpstashWorldConfig {
  /**
   * Neon database connection string
   * Example: postgresql://user:pass@ep-xxx.us-east-1.aws.neon.tech/dbname?sslmode=require
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

  /**
   * Optional Neon configuration
   */
  neonConfig?: Partial<typeof neonConfig>;
}

export function createNeonUpstashWorld(
  config: NeonUpstashWorldConfig = {
    databaseUrl:
      process.env.DATABASE_URL ||
      'postgresql://localhost:5432/neon_upstash_test',
    qstash: {
      token: process.env.QSTASH_TOKEN || '',
      targetUrl: process.env.QSTASH_URL || 'http://localhost:8080',
    },
  }
): World {
  const {
    databaseUrl,
    qstash,
    deploymentId = 'neon-upstash-default',
    ownerId = '',
    projectId = '',
    environment = process.env.NODE_ENV || 'development',
  } = config;

  // Configure Neon
  if (config.neonConfig) {
    Object.assign(neonConfig, config.neonConfig);
  }

  // Create Neon client
  const sql = neon(databaseUrl);
  const db = drizzle(sql, { schema });

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
export { createNeonUpstashWorld as createWorld };
