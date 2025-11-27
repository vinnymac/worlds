import { config } from 'dotenv';
import { Redis } from 'ioredis';

async function setupRedis() {
  // Load .env file if it exists
  config();

  const connectionString =
    process.env.WORKFLOW_REDIS_URL ||
    process.env.REDIS_URL ||
    'redis://localhost:6379';

  const keyPrefix = process.env.WORKFLOW_REDIS_KEY_PREFIX || 'workflow:';

  console.log('🔧 Setting up Redis for Workflow...');
  console.log(
    `📍 Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, '$1[redacted]@')}`
  );
  console.log(`📍 Key Prefix: ${keyPrefix}`);

  try {
    const redis = new Redis(connectionString);

    // Test connection
    await redis.ping();
    console.log('✅ Successfully connected to Redis!');

    // Get Redis info
    const info = await redis.info('server');
    const version = info.match(/redis_version:([^\r\n]+)/)?.[1];
    if (version) {
      console.log(`📦 Redis version: ${version}`);
    }

    // Check if any workflow keys exist
    const existingKeys = await redis.keys(`${keyPrefix}*`);
    if (existingKeys.length > 0) {
      console.log(
        `\n⚠️  Found ${existingKeys.length} existing workflow keys with prefix "${keyPrefix}"`
      );
      console.log(
        '\nTo flush existing workflow data, run with FLUSH=true environment variable:'
      );
      console.log('  FLUSH=true pnpm workflow-redis-setup');

      if (process.env.FLUSH === 'true') {
        console.log('\n🗑️  Flushing existing workflow data...');
        const pipeline = redis.pipeline();
        for (const key of existingKeys) {
          pipeline.del(key);
        }
        await pipeline.exec();
        console.log(`✅ Deleted ${existingKeys.length} keys`);
      }
    } else {
      console.log(`\n✨ No existing workflow data found (clean slate)`);
    }

    console.log('\n📋 Redis is ready for Workflow DevKit!');
    console.log('\nThe following Redis data structures will be used:');
    console.log(
      `  - Hashes: ${keyPrefix}run:*, ${keyPrefix}step:*, ${keyPrefix}event:*, ${keyPrefix}hook:*`
    );
    console.log(
      `  - Sorted Sets: ${keyPrefix}runs:*, ${keyPrefix}steps:*, ${keyPrefix}events:*`
    );
    console.log(`  - Streams: ${keyPrefix}stream:*`);
    console.log(`  - BullMQ Queues: workflow_flows, workflow_steps`);

    await redis.quit();
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to setup Redis:', error);
    process.exit(1);
  }
}

// Check if running as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  setupRedis();
}

export { setupRedis };
