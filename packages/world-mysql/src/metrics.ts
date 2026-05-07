import { sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type * as schema from './schema.js';

type Drizzle = MySql2Database<typeof schema>;

export interface QueueMetrics {
  /** Total messages successfully processed since startup */
  messagesProcessed: number;
  /** Total messages that permanently failed since startup */
  messagesErrored: number;
  /** Total messages that were retried since startup */
  messageRetries: number;
  /** Median processing time in ms (from recent window) */
  processingTimeMsP50: number;
  /** 95th percentile processing time in ms (from recent window) */
  processingTimeMsP95: number;
  /** 99th percentile processing time in ms (from recent window) */
  processingTimeMsP99: number;
  /** Current number of pending jobs in the queue */
  queueDepth: number;
  /** Age of the oldest pending job in milliseconds */
  oldestPendingJobAgeMs: number;
}

interface QueueCounts {
  processed: number;
  errored: number;
  retries: number;
}

/** Maximum number of recent latency samples to keep per queue */
const MAX_LATENCY_SAMPLES = 1000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length * p) / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

class MetricsCollector {
  private counts = new Map<string, QueueCounts>();
  private latencies = new Map<string, number[]>();

  recordProcessed(queueName: string, durationMs: number): void {
    const m = this.getOrCreate(queueName);
    m.processed++;
    const lats = this.latencies.get(queueName) ?? [];
    lats.push(durationMs);
    if (lats.length > MAX_LATENCY_SAMPLES) lats.shift();
    this.latencies.set(queueName, lats);
  }

  recordError(queueName: string, isRetry: boolean): void {
    const m = this.getOrCreate(queueName);
    if (isRetry) {
      m.retries++;
    } else {
      m.errored++;
    }
  }

  async getMetrics(db: Drizzle, queueName: string): Promise<QueueMetrics> {
    const depthResult = await db.execute(sql`
      SELECT COUNT(*) as depth FROM \`workflow\`.\`workflow_jobs\`
      WHERE \`queue_name\` = ${queueName} AND \`status\` = 'pending'
    `);
    const depthRows = (depthResult as unknown as [Array<{ depth: number }>, unknown])[0];
    const depth = Number(depthRows?.[0]?.depth ?? 0);

    const oldestResult = await db.execute(sql`
      SELECT TIMESTAMPDIFF(MICROSECOND, MIN(\`created_at\`), NOW()) / 1000 as oldest
      FROM \`workflow\`.\`workflow_jobs\`
      WHERE \`queue_name\` = ${queueName} AND \`status\` = 'pending'
    `);
    const oldestRows = (oldestResult as unknown as [Array<{ oldest: number | null }>, unknown])[0];
    const oldest = Number(oldestRows?.[0]?.oldest ?? 0);

    const lats = (this.latencies.get(queueName) ?? []).slice().sort((a, b) => a - b);
    const counts = this.getOrCreate(queueName);

    return {
      messagesProcessed: counts.processed,
      messagesErrored: counts.errored,
      messageRetries: counts.retries,
      processingTimeMsP50: percentile(lats, 50),
      processingTimeMsP95: percentile(lats, 95),
      processingTimeMsP99: percentile(lats, 99),
      queueDepth: depth,
      oldestPendingJobAgeMs: oldest,
    };
  }

  /** Reset all collected metrics (useful for testing) */
  reset(): void {
    this.counts.clear();
    this.latencies.clear();
  }

  private getOrCreate(queueName: string): QueueCounts {
    let existing = this.counts.get(queueName);
    if (!existing) {
      existing = { processed: 0, errored: 0, retries: 0 };
      this.counts.set(queueName, existing);
    }
    return existing;
  }
}

export const metrics = new MetricsCollector();
