// Benchmark the world-redis hot paths that back every runtime interaction:
// run creation (one event append + entity create), serial event appends,
// concurrent appends on one run, and event log reads.
//
// The events.create surface is shape-identical on the 4.x and 5.x specs, so
// the same script produces comparable numbers on main and vt/wf-5.
//
// Usage:
//   REDIS_URL=redis://localhost:6379 node bench/world-redis.bench.mjs [dist]
// where [dist] defaults to ../packages/world-redis/dist/index.js relative to
// this file. Prints a JSON report to stdout.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const RUNS_SERIAL = 300;
const RUNS_CONCURRENT = 200;
const CONCURRENCY = 16;
const APPENDS_SERIAL = 400;
const APPENDS_CONCURRENT = 200;
const LIST_READS = 100;

const distArg = process.argv[2] ?? path.resolve(import.meta.dirname, '../packages/world-redis/dist/index.js');
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error('REDIS_URL is required');
  process.exit(1);
}

const { createWorld } = await import(pathToFileURL(distArg).href);

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function timed(name, total, fn) {
  const latencies = new Array(total);
  const start = performance.now();
  await fn(latencies);
  const wall = performance.now() - start;
  const sorted = latencies.filter((v) => v !== undefined).sort((a, b) => a - b);
  return {
    name,
    ops: sorted.length,
    wallMs: Math.round(wall),
    opsPerSec: Math.round((sorted.length / wall) * 1000),
    p50Ms: Number(percentile(sorted, 50).toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 99).toFixed(2)),
  };
}

async function pooled(total, concurrency, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const i = next++;
        if (i >= total) return;
        await work(i);
      }
    }),
  );
}

const world = createWorld({
  redis: redisUrl,
  keyPrefix: `bench:${Date.now()}:`,
  queueConcurrency: 1,
});

const createRun = async () => {
  const result = await world.events.create(null, {
    eventType: 'run_created',
    eventData: { deploymentId: 'bench-deploy', workflowName: 'bench-workflow', input: [1, 2, 3] },
  });
  return result.run;
};

const results = [];

results.push(
  await timed('runs.create serial', RUNS_SERIAL, async (lat) => {
    for (let i = 0; i < RUNS_SERIAL; i++) {
      const t = performance.now();
      await createRun();
      lat[i] = performance.now() - t;
    }
  }),
);

results.push(
  await timed(`runs.create x${CONCURRENCY} concurrent`, RUNS_CONCURRENT, async (lat) => {
    await pooled(RUNS_CONCURRENT, CONCURRENCY, async (i) => {
      const t = performance.now();
      await createRun();
      lat[i] = performance.now() - t;
    });
  }),
);

const serialRun = await createRun();
await world.events.create(serialRun.runId, { eventType: 'run_started' });
results.push(
  await timed('events.create serial one run', APPENDS_SERIAL, async (lat) => {
    for (let i = 0; i < APPENDS_SERIAL; i++) {
      const t = performance.now();
      await world.events.create(serialRun.runId, {
        eventType: 'step_created',
        correlationId: `step-serial-${i}`,
        eventData: { stepName: 'bench-step', input: [i] },
      });
      lat[i] = performance.now() - t;
    }
  }),
);

const contendedRun = await createRun();
await world.events.create(contendedRun.runId, { eventType: 'run_started' });
results.push(
  await timed(`events.create x${CONCURRENCY} contended one run`, APPENDS_CONCURRENT, async (lat) => {
    await pooled(APPENDS_CONCURRENT, CONCURRENCY, async (i) => {
      const t = performance.now();
      await world.events.create(contendedRun.runId, {
        eventType: 'step_created',
        correlationId: `step-contended-${i}`,
        eventData: { stepName: 'bench-step', input: [i] },
      });
      lat[i] = performance.now() - t;
    });
  }),
);

results.push(
  await timed('events.list 400-event log', LIST_READS, async (lat) => {
    for (let i = 0; i < LIST_READS; i++) {
      const t = performance.now();
      await world.events.list(serialRun.runId, {});
      lat[i] = performance.now() - t;
    }
  }),
);

console.log(JSON.stringify({ dist: distArg, node: process.version, results }, null, 2));
await world.close?.();
process.exit(0);
