/**
 * Load an env file when present without making a `.env` file mandatory.
 *
 * Node 24 provides the parser natively, so published worlds do not need a
 * runtime dependency solely to load local development configuration.
 */
export function loadOptionalEnvFile(path?: string): void {
  try {
    if (path === undefined) {
      process.loadEnvFile();
    } else {
      process.loadEnvFile(path);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
