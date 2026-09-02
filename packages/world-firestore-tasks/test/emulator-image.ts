/**
 * The google-cloud-cli image every Firestore test suite in this package boots.
 *
 * gcr.io keeps only a rolling window of roughly the last 99 `-emulators` tags
 * (about a year of weekly gcloud releases). Older pins are deleted outright, so
 * a tag that resolves today returns `manifest unknown` once it ages out. This
 * pin has to be refreshed before it falls off that window; the symptom is every
 * suite here failing in `beforeAll` with a 404 from the Docker daemon.
 *
 * Keep `.github/workflows/tests.yml`'s pre-pull entry for
 * `@fantasticfour/world-firestore-tasks` in sync with this value. The workflow
 * matrix cannot import TypeScript, so `workflow-image-pin.test.ts` asserts the
 * two agree.
 */
export const FIRESTORE_EMULATOR_IMAGE =
  'gcr.io/google.com/cloudsdktool/google-cloud-cli:583.0.0-emulators';
