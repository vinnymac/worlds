import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOptionalEnvFile } from '../src/env.js';

const ENV_KEY = 'FANTASTICFOUR_NATIVE_ENV_FILE_TEST';
let temporaryDirectory: string | undefined;

afterEach(async () => {
  delete process.env[ENV_KEY];
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe('loadOptionalEnvFile', () => {
  it('loads an env file through Node without dotenv', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'fantasticfour-env-'));
    const envFile = join(temporaryDirectory, '.env');
    await writeFile(envFile, `${ENV_KEY}=loaded-by-node\n`);

    loadOptionalEnvFile(envFile);

    expect(process.env[ENV_KEY]).toBe('loaded-by-node');
  });

  it('ignores an absent optional env file', () => {
    expect(() => loadOptionalEnvFile(join(tmpdir(), 'does-not-exist.env'))).not.toThrow();
  });
});
