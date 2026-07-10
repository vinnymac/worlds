import { MySqlContainer } from '@testcontainers/mysql';
import { encode, decode } from 'cbor-x';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { eq, sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupExpiredIdempotencyKeys, reclaimStaleJobs } from '../src/queue.js';
import * as schema from '../src/schema.js';
import { applyMigrations } from './migrate.js';

const shouldSkipTests = process.platform === 'win32';

describe.skipIf(shouldSkipTests)('MySQL Queue internals', () => {
  let mysqlContainer: Awaited<ReturnType<InstanceType<typeof MySqlContainer>['start']>>;
  let db: MySql2Database<typeof schema>;
  let pool: mysql.Pool;

  beforeAll(async () => {
    mysqlContainer = await new MySqlContainer('mysql:8.0')
      .withDatabase('main')
      .withUsername('testuser')
      .withRootPassword('root')
      .withCommand(['--default-authentication-plugin=mysql_native_password'])
      .start();

    const dbUrl = `mysql://root:root@${mysqlContainer.getHost()}:${mysqlContainer.getPort()}/main`;
    pool = mysql.createPool(dbUrl);
    db = drizzle(pool, { schema, mode: 'default' });

    // Create tables from the real migrations
    const connection = await mysql.createConnection(dbUrl);
    await applyMigrations(connection);
    await connection.end();
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await mysqlContainer?.stop();
  });

  it('can insert and fetch a job using raw SQL', async () => {
    const payload = Buffer.from(encode({ runId: 'test_run_1', requestedAt: new Date() }));

    // Insert a job
    await db.execute(sql`
      INSERT INTO \`workflow\`.\`workflow_jobs\` (\`job_id\`, \`queue_name\`, \`payload\`, \`status\`)
      VALUES ('msg_test1', 'workflow_flows', ${payload}, 'pending')
    `);

    // Fetch using same query as fetchJob
    const rawResult = await db.execute(sql`
      SELECT * FROM \`workflow\`.\`workflow_jobs\`
      WHERE \`queue_name\` = 'workflow_flows'
        AND \`status\` = 'pending'
        AND (\`scheduled_for\` IS NULL OR \`scheduled_for\` <= NOW())
      ORDER BY \`id\` ASC
      LIMIT 1
    `);

    console.log('rawResult type:', typeof rawResult);
    console.log('rawResult is array:', Array.isArray(rawResult));
    console.log(
      'rawResult:',
      JSON.stringify(
        rawResult,
        (_, v) => {
          if (v instanceof Buffer) return `<Buffer ${v.length} bytes>`;
          return v;
        },
        2,
      ).slice(0, 2000),
    );

    const outerArray = rawResult as any;
    console.log('outerArray[0] type:', typeof outerArray[0]);
    console.log('outerArray[0] is array:', Array.isArray(outerArray[0]));
    console.log('outerArray[0] length:', outerArray[0]?.length);

    // drizzle mysql2 execute returns [[rows], [fields]] or similar nested structure
    const rows = Array.isArray(outerArray[0]) ? outerArray[0] : outerArray;
    expect(rows.length).toBeGreaterThan(0);
    const job = rows[0];
    console.log('job keys:', Object.keys(job));
    console.log('job.id:', job.id);
    console.log('job.job_id:', job.job_id);
    expect(job.id).toBeDefined();
    expect(job.job_id).toBe('msg_test1');
    expect(job.queue_name).toBe('workflow_flows');

    // Test CBOR decode
    const decoded = decode(job.payload);
    console.log('decoded payload:', decoded);
    expect(decoded.runId).toBe('test_run_1');
  });

  it('FOR UPDATE SKIP LOCKED works in transaction', async () => {
    const payload = Buffer.from(encode({ runId: 'test_run_2' }));

    await db.execute(sql`
      INSERT INTO \`workflow\`.\`workflow_jobs\` (\`job_id\`, \`queue_name\`, \`payload\`, \`status\`)
      VALUES ('msg_test2', 'workflow_flows', ${payload}, 'pending')
    `);

    const result = await db.transaction(async (tx) => {
      const rawResult = await tx.execute(sql`
        SELECT * FROM \`workflow\`.\`workflow_jobs\`
        WHERE \`queue_name\` = 'workflow_flows'
          AND \`status\` = 'pending'
          AND (\`scheduled_for\` IS NULL OR \`scheduled_for\` <= NOW())
        ORDER BY \`id\` ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);

      console.log('TX rawResult type:', typeof rawResult);
      console.log('TX rawResult is array:', Array.isArray(rawResult));
      console.log('TX rawResult length:', (rawResult as any)?.length);
      console.log('TX rawResult[0] type:', typeof (rawResult as any)?.[0]);
      console.log('TX rawResult[0] is array:', Array.isArray((rawResult as any)?.[0]));
      console.log('TX rawResult[0] length:', (rawResult as any)?.[0]?.length);
      if (Array.isArray((rawResult as any)?.[0])) {
        console.log(
          'TX rawResult[0][0] keys:',
          (rawResult as any)?.[0]?.[0] && Object.keys((rawResult as any)[0][0]),
        );
      }

      // Same structure as non-tx: [[rows], [fields]]
      const outerArray = rawResult as any;
      const rows = Array.isArray(outerArray[0]) ? outerArray[0] : outerArray;
      if (!rows || rows.length === 0) return null;
      return rows[0];
    });

    console.log('transaction result:', result ? Object.keys(result) : 'null');
    expect(result).not.toBeNull();
    expect(result.queue_name).toBe('workflow_flows');
  });

  it('reclaims stale processing jobs and fails exhausted ones', async () => {
    const payload = Buffer.from(encode({ runId: 'test_run_reclaim' }));
    const staleLockedAt = new Date(Date.now() - 10 * 60 * 1000);

    // Orphaned job with attempts remaining → back to pending
    await db.insert(schema.jobs).values({
      jobId: 'msg_reclaim_pending',
      queueName: 'workflow_flows',
      payload,
      status: 'processing',
      attempt: 1,
      maxAttempts: 3,
      lockedAt: staleLockedAt,
      lockedBy: 'dead_worker',
    });
    // Orphaned job with attempts exhausted → failed
    await db.insert(schema.jobs).values({
      jobId: 'msg_reclaim_failed',
      queueName: 'workflow_flows',
      payload,
      status: 'processing',
      attempt: 3,
      maxAttempts: 3,
      lockedAt: staleLockedAt,
      lockedBy: 'dead_worker',
    });
    // Actively processing job (fresh lock) → untouched
    await db.insert(schema.jobs).values({
      jobId: 'msg_reclaim_active',
      queueName: 'workflow_flows',
      payload,
      status: 'processing',
      attempt: 1,
      maxAttempts: 3,
      lockedAt: new Date(),
      lockedBy: 'live_worker',
    });

    const reclaimed = await reclaimStaleJobs(db, 5 * 60 * 1000);
    expect(reclaimed).toBe(2);

    const [reset] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobId, 'msg_reclaim_pending'));
    expect(reset.status).toBe('pending');
    expect(reset.lockedBy).toBeNull();

    const [failed] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobId, 'msg_reclaim_failed'));
    expect(failed.status).toBe('failed');

    const [active] = await db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobId, 'msg_reclaim_active'));
    expect(active.status).toBe('processing');
  });

  it('idempotency TTL cleanup keeps keys for still-queued jobs', async () => {
    const payload = Buffer.from(encode({ runId: 'test_run_idem' }));
    const expiredCreatedAt = new Date(Date.now() - 10 * 60 * 1000);

    // Expired key whose job is still scheduled → must survive cleanup
    await db.insert(schema.jobs).values({
      jobId: 'msg_idem_live',
      queueName: 'workflow_steps',
      idempotencyKey: 'step_live',
      payload,
      status: 'pending',
      scheduledFor: new Date(Date.now() + 30 * 60 * 1000),
    });
    await db.insert(schema.idempotency).values({
      idempotencyKey: 'step_live',
      messageId: 'msg_idem_live',
      queueName: 'workflow_steps',
      createdAt: expiredCreatedAt,
    });

    // Expired key whose job is gone (completed) → released
    await db.insert(schema.idempotency).values({
      idempotencyKey: 'step_done',
      messageId: 'msg_idem_done',
      queueName: 'workflow_steps',
      createdAt: expiredCreatedAt,
    });

    const released = await cleanupExpiredIdempotencyKeys(db, 5 * 60 * 1000);
    expect(released).toBe(1);

    const remaining = await db.select().from(schema.idempotency);
    expect(remaining.map((r) => r.idempotencyKey)).toEqual(['step_live']);
  });
});
