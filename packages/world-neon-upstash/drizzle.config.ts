import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://localhost:5432/neon_upstash_test',
  },
  schema: './src/schema.ts',
  out: './migrations',
});
