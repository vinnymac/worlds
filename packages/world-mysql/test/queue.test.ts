import { MySqlContainer } from '@testcontainers/mysql';
import { encode, decode } from 'cbor-x';
import { drizzle } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema.js';

const shouldSkipTests = process.platform === 'win32';

describe.skipIf(shouldSkipTests)('MySQL Queue internals', () => {
  let mysqlContainer: Awaited<ReturnType<InstanceType<typeof MySqlContainer>['start']>>;
  let db: ReturnType<typeof drizzle>;
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

    // Create tables
    const connection = await mysql.createConnection(dbUrl);
    await connection.execute('CREATE SCHEMA IF NOT EXISTS `workflow`');
    await connection.execute(`CREATE TABLE \`workflow\`.\`workflow_jobs\` (
      \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`job_id\` VARCHAR(255) NOT NULL UNIQUE,
      \`queue_name\` VARCHAR(255) NOT NULL,
      \`payload\` BLOB NOT NULL,
      \`status\` ENUM('pending','processing','failed') NOT NULL DEFAULT 'pending',
      \`attempt\` INT NOT NULL DEFAULT 0,
      \`max_attempts\` INT NOT NULL DEFAULT 3,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`locked_at\` TIMESTAMP NULL,
      \`locked_by\` VARCHAR(255),
      \`error\` TEXT,
      \`scheduled_for\` TIMESTAMP NULL,
      INDEX \`idx_jobs_queue_status\` (\`queue_name\`, \`status\`, \`id\`),
      INDEX \`idx_jobs_scheduled\` (\`scheduled_for\`)
    )`);
    await connection.execute(`CREATE TABLE \`workflow\`.\`workflow_job_idempotency\` (
      \`idempotency_key\` VARCHAR(255) NOT NULL PRIMARY KEY,
      \`message_id\` VARCHAR(255) NOT NULL,
      \`queue_name\` VARCHAR(255) NOT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX \`idx_idempotency_created\` (\`created_at\`)
    )`);
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
});
