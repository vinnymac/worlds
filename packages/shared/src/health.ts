export interface ComponentHealth {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  components: {
    storage: ComponentHealth;
    queue: ComponentHealth;
    streamer: ComponentHealth;
  };
  metadata?: Record<string, unknown>;
}

export interface HealthCheckable {
  health(): Promise<HealthCheckResult>;
}

export async function timeOperation<T>(
  fn: () => Promise<T>,
): Promise<{ result: T | null; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { result, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      result: null,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
