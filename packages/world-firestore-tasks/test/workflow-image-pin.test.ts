import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIRESTORE_EMULATOR_IMAGE } from './emulator-image.js';

// The CI matrix pre-pulls the emulator image so the download overlaps
// install/build. That pin has to be a literal in YAML, so it can silently drift
// from the one the suites actually boot; the cost is a lost latency
// optimization plus a confusing pull of an image nothing uses.
describe('CI pre-pull pin', () => {
  it('matches the image the suites boot', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/tests.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain(FIRESTORE_EMULATOR_IMAGE);
  });
});
