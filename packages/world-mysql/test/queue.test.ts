import { MySqlContainer } from '@testcontainers/mysql';
import { encode, decode } from 'cbor-x';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { eq, sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupExpiredIdempotencyKeys,
  completeJob,
  createQueue,
  fetchJob,
  handleJobFailure,
  reclaimStaleJobs,
  rescheduleJob,
} from '../src/queue.js';
import type { RawJobRow } from '../src/queue.js';
import * as schema from '../src/schema.js';
import { applyMigrations } from '../src/migrate.js';

const shouldSkipTests = process.platform === 'win32';

// drizzle's mysql2 driver types execute() as [ResultSetHeader, FieldPacket[]] always,
// but a raw SELECT actually returns [RowDataPacket[], FieldPacket[]] at runtime.
type RawSelectResult = [RawJobRow[], unknown[]];

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

    const outerArray = rawResult as unknown as RawSelectResult;
    console.log('outerArray[0] type:', typeof outerArray[0]);
    console.log('outerArray[0] is array:', Array.isArray(outerArray[0]));
    console.log('outerArray[0] length:', outerArray[0]?.length);

    // drizzle's mysql2 driver returns `[rows, fields]` for a raw SELECT.
    const rows = outerArray[0];
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

      const rawTuple = rawResult as unknown as RawSelectResult;

      console.log('TX rawResult type:', typeof rawResult);
      console.log('TX rawResult is array:', Array.isArray(rawResult));
      console.log('TX rawResult length:', rawTuple.length);
      console.log('TX rawResult[0] type:', typeof rawTuple[0]);
      console.log('TX rawResult[0] is array:', Array.isArray(rawTuple[0]));
      console.log('TX rawResult[0] length:', rawTuple[0]?.length);
      if (Array.isArray(rawTuple[0])) {
        console.log('TX rawResult[0][0] keys:', rawTuple[0][0] && Object.keys(rawTuple[0][0]));
      }

      // drizzle's mysql2 driver returns `[rows, fields]` for a raw SELECT.
      const rows = rawTuple[0];
      if (!rows || rows.length === 0) return null;
      return rows[0];
    });

    console.log('transaction result:', result ? Object.keys(result) : 'null');
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error('expected a job row from the transaction');
    }
    expect(result.queue_name).toBe('workflow_flows');
  });

  it('reclaims stale processing jobs and fails exhausted ones', async () => {
    const payload = Buffer.from(encode({ runId: 'test_run_reclaim' }));
    const staleLockedAt = new Date(Date.now() - 10 * 60 * 1000);

    // Orphaned job with attempts remaining -> back to pending
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
    // Orphaned job with attempts exhausted -> failed
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
    // Actively processing job (fresh lock) -> untouched
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

    // Expired key whose job is still scheduled -> must survive cleanup
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

    // Expired key whose job is gone (completed) -> released
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
  describe('claim fencing', () => {
    async function enqueue(jobId: string, queueName: string) {
      await db.insert(schema.jobs).values({
        jobId,
        queueName,
        idempotencyKey: `key_${jobId}`,
        payload: Buffer.from(encode({ runId: jobId })),
        status: 'pending',
      });
      await db.insert(schema.idempotency).values({
        idempotencyKey: `key_${jobId}`,
        messageId: jobId,
        queueName,
      });
    }

    async function rowOf(jobId: string) {
      const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.jobId, jobId));
      return row;
    }

    async function keyOf(jobId: string) {
      return db
        .select()
        .from(schema.idempotency)
        .where(eq(schema.idempotency.idempotencyKey, `key_${jobId}`));
    }

    async function claim(queueName: string, workerId: string) {
      const job = await fetchJob(db, queueName, workerId);
      if (!job) throw new Error(`no job claimable on ${queueName}`);
      return job;
    }

    it('ignores every settle from a claim that was reclaimed and redelivered', async () => {
      await enqueue('msg_fence_stale', 'fence_stale');
      const stale = await claim('fence_stale', 'worker_a');
      expect(stale.claim_token).toEqual(expect.any(String));

      // Stall past the visibility timeout, then redeliver to worker_b.
      await db
        .update(schema.jobs)
        .set({ lockedAt: new Date(Date.now() - 10 * 60 * 1000) })
        .where(eq(schema.jobs.jobId, 'msg_fence_stale'));
      expect(await reclaimStaleJobs(db, 5 * 60 * 1000)).toBe(1);
      const live = await claim('fence_stale', 'worker_b');
      expect(live.claim_token).not.toBe(stale.claim_token);
      const before = await rowOf('msg_fence_stale');

      expect(await completeJob(db, stale)).toBe(false);
      expect(await handleJobFailure(db, stale, new Error('stale retry'))).toBe(false);
      expect(
        await handleJobFailure(db, { ...stale, attempt: 3 }, new Error('stale exhausted')),
      ).toBe(false);
      expect(await rescheduleJob(db, stale, 60_000)).toBe(false);

      expect(await rowOf('msg_fence_stale')).toEqual(before);
      expect(before.status).toBe('processing');
      expect(before.lockedBy).toBe('worker_b');
      expect(before.attempt).toBe(2);
      expect(await keyOf('msg_fence_stale')).toHaveLength(1);

      // Replicas sharing a configured workerId are fenced by the token alone.
      await completeJob(db, { ...stale, locked_by: 'worker_b' });
      expect(await rowOf('msg_fence_stale')).toEqual(before);

      // Same token but a different holder (pre-fencing reclaim left it) is stale too.
      await completeJob(db, { ...live, locked_by: 'worker_a' });
      expect(await rowOf('msg_fence_stale')).toEqual(before);

      const settled = vi.fn();
      expect(await completeJob(db, { ...stale, locked_by: 'worker_b' }, settled)).toBe(false);
      expect(settled).not.toHaveBeenCalled();
      expect(await completeJob(db, live, settled)).toBe(true);
      // Fires with the row gone, before the idempotency key is released.
      expect(settled).toHaveBeenCalledTimes(1);
      expect(await rowOf('msg_fence_stale')).toBeUndefined();
      expect(await keyOf('msg_fence_stale')).toHaveLength(0);
    });

    it('settles the current claim normally', async () => {
      await enqueue('msg_fence_live', 'fence_live');

      const first = await claim('fence_live', 'worker_a');
      expect(await handleJobFailure(db, first, new Error('boom'))).toBe(true);
      const retried = await rowOf('msg_fence_live');
      expect(retried.status).toBe('pending');
      expect(retried.error).toBe('boom');
      expect(retried.claimToken).toBeNull();
      expect(retried.lockedBy).toBeNull();
      expect(retried.scheduledFor).not.toBeNull();

      await db
        .update(schema.jobs)
        .set({ scheduledFor: null })
        .where(eq(schema.jobs.jobId, 'msg_fence_live'));
      const second = await claim('fence_live', 'worker_a');
      expect(second.attempt).toBe(2);
      expect(await rescheduleJob(db, second, 60_000)).toBe(true);
      const rescheduled = await rowOf('msg_fence_live');
      expect(rescheduled.status).toBe('pending');
      expect(rescheduled.attempt).toBe(1);
      expect(rescheduled.claimToken).toBeNull();

      await db
        .update(schema.jobs)
        .set({ scheduledFor: null })
        .where(eq(schema.jobs.jobId, 'msg_fence_live'));
      const third = await claim('fence_live', 'worker_a');
      expect(await handleJobFailure(db, { ...third, attempt: 3 }, new Error('fatal'))).toBe(true);
      const failed = await rowOf('msg_fence_live');
      expect(failed.status).toBe('failed');
      expect(failed.claimToken).toBeNull();
      expect(await keyOf('msg_fence_live')).toHaveLength(0);
    });

    // fetchJob always writes a token, so this only pins `<=>` against a regression to `=`.
    it('settles a row whose claim_token is NULL', async () => {
      await enqueue('msg_fence_legacy', 'fence_legacy');
      await db
        .update(schema.jobs)
        .set({ status: 'processing', lockedAt: new Date(), lockedBy: 'old_worker', attempt: 1 })
        .where(eq(schema.jobs.jobId, 'msg_fence_legacy'));
      const [raw] = (await db.execute(sql`
        SELECT * FROM \`workflow\`.\`workflow_jobs\` WHERE \`job_id\` = 'msg_fence_legacy'
      `)) as unknown as RawSelectResult;
      const legacy = raw[0];
      expect(legacy?.claim_token).toBeNull();
      if (!legacy) throw new Error('legacy row missing');

      await completeJob(db, legacy);
      expect(await rowOf('msg_fence_legacy')).toBeUndefined();
      expect(await keyOf('msg_fence_legacy')).toHaveLength(0);
    });
  });

  it('refuses to start against a database with no tables', async () => {
    await db.execute(
      sql`RENAME TABLE \`workflow\`.\`workflow_jobs\` TO \`workflow\`.\`jobs_away\``,
    );
    try {
      await expect(createQueue(db).start()).rejects.toThrow(/run world-mysql-setup/);
    } finally {
      await db.execute(
        sql`RENAME TABLE \`workflow\`.\`jobs_away\` TO \`workflow\`.\`workflow_jobs\``,
      );
    }
  });

  it('refuses to start before the claim_token migration has run', async () => {
    await db.execute(sql`ALTER TABLE \`workflow\`.\`workflow_jobs\` DROP COLUMN \`claim_token\``);
    try {
      await expect(createQueue(db).start()).rejects.toThrow(/run world-mysql-setup/);
    } finally {
      await db.execute(sql`
        ALTER TABLE \`workflow\`.\`workflow_jobs\`
          ADD COLUMN \`claim_token\` VARCHAR(64) NULL AFTER \`locked_by\`
      `);
    }
  });
});
