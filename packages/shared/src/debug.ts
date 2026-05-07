/**
 * Creates a namespaced debug logger.
 * Logs to stderr to avoid corrupting CLI JSON output on stdout.
 *
 * Control via WORKFLOW_DEBUG environment variable:
 *   WORKFLOW_DEBUG=1                       // Enable all
 *   WORKFLOW_DEBUG=mysql-world             // Specific namespace
 *   WORKFLOW_DEBUG=mysql-world,redis-world // Multiple namespaces
 */
export function createDebugLogger(namespace: string) {
  return (...args: unknown[]) => {
    const debug = process.env.WORKFLOW_DEBUG;
    if (!debug) return;

    const enabled =
      debug === '1' ||
      debug === 'true' ||
      debug === '*' ||
      debug.split(',').some((ns) => ns.trim() === namespace);

    if (!enabled) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${namespace}]`;
    const message = args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)))
      .join(' ');

    process.stderr.write(`${prefix} ${message}\n`);
  };
}
