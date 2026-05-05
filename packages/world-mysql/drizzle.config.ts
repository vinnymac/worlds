import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'mysql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'mysql://root:root@localhost:3306/mysql_test',
  },
  schema: './dist/schema.js',
  out: './migrations',
});
