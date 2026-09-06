/**
 * Node resolve hook loaded via --import by the test:workers script.
 *
 * The workspace overrides zod to 4.x for the @workflow 5 packages, but
 * @cloudflare/vitest-pool-workers@0.19.1 declares zod 3 and calls its classic
 * API (z.ostring) at config-load time. zod 4 still ships that API under the
 * `zod/v3` subpath, so bare `zod` imports are redirected there for the pool
 * alone; every other importer keeps the zod 4 entrypoint.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === 'zod' &&
      context.parentURL?.includes('/node_modules/@cloudflare/vitest-pool-workers/')
    ) {
      return nextResolve('zod/v3', context);
    }
    return nextResolve(specifier, context);
  },
});
