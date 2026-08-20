/**
 * Prints a tsdown config's `entry` map as JSON.
 *
 * A subprocess rather than a Vitest import so the config is evaluated the way
 * the build evaluates it: plain Node (type stripping handles the `.ts`), with
 * `tsdown` resolved from the world's own node_modules.
 */

const configUrl = process.argv[2];
const module = await import(configUrl);

const resolved = typeof module.default === 'function' ? await module.default({}) : module.default;
const configs = Array.isArray(resolved) ? resolved : [resolved];

process.stdout.write(JSON.stringify(configs.map((config) => config?.entry ?? null)));
