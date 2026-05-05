#!/usr/bin/env node
import('../dist/cli.js')
  .then((module) => module.setupDatabase())
  .catch((err) => {
    console.error('Failed to load CLI:', err);
    process.exit(1);
  });
