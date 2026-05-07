import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createDebugLogger } from './debug.js';

export interface CorrelationContext {
  correlationId: string;
  runId?: string;
  stepId?: string;
  traceparent?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function withCorrelation<T>(context: Partial<CorrelationContext>, fn: () => T): T {
  const existing = storage.getStore();
  const merged: CorrelationContext = {
    correlationId: context.correlationId ?? existing?.correlationId ?? randomUUID(),
    runId: context.runId ?? existing?.runId,
    stepId: context.stepId ?? existing?.stepId,
    traceparent: context.traceparent ?? existing?.traceparent,
  };
  return storage.run(merged, fn);
}

/**
 * Enhanced debug logger that includes correlation context.
 */
export function createCorrelatedLogger(namespace: string) {
  const baseLogger = createDebugLogger(namespace);
  return (...args: unknown[]) => {
    const ctx = getCorrelationContext();
    if (ctx) {
      const prefix = [
        ctx.correlationId && `cid=${ctx.correlationId}`,
        ctx.runId && `run=${ctx.runId}`,
        ctx.stepId && `step=${ctx.stepId}`,
      ]
        .filter(Boolean)
        .join(' ');
      baseLogger(`[${prefix}]`, ...args);
    } else {
      baseLogger(...args);
    }
  };
}
