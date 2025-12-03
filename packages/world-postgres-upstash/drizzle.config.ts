import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://localhost:5432/postgres_upstash_test',
  },
  schema: './dist/schema.js',
  out: './migrations',
});
