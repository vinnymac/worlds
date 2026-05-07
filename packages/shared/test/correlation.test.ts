import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCorrelatedLogger,
  getCorrelationContext,
  getCorrelationId,
  withCorrelation,
} from '../src/correlation.js';

describe('correlation', () => {
  describe('withCorrelation', () => {
    it('provides correlation context to nested calls', () => {
      withCorrelation({ correlationId: 'test-123' }, () => {
        const ctx = getCorrelationContext();
        expect(ctx?.correlationId).toBe('test-123');
      });
    });

    it('generates correlationId when not provided', () => {
      withCorrelation({}, () => {
        const id = getCorrelationId();
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
      });
    });

    it('inherits parent context', () => {
      withCorrelation({ correlationId: 'parent', runId: 'run-1' }, () => {
        withCorrelation({ stepId: 'step-1' }, () => {
          const ctx = getCorrelationContext();
          expect(ctx?.correlationId).toBe('parent');
          expect(ctx?.runId).toBe('run-1');
          expect(ctx?.stepId).toBe('step-1');
        });
      });
    });

    it('allows child to override parent values', () => {
      withCorrelation({ correlationId: 'parent', runId: 'run-1' }, () => {
        withCorrelation({ runId: 'run-2' }, () => {
          const ctx = getCorrelationContext();
          expect(ctx?.correlationId).toBe('parent');
          expect(ctx?.runId).toBe('run-2');
        });
      });
    });

    it('returns undefined outside correlation scope', () => {
      expect(getCorrelationContext()).toBeUndefined();
      expect(getCorrelationId()).toBeUndefined();
    });
  });

  describe('createCorrelatedLogger', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.env.WORKFLOW_DEBUG = '1';
    });

    afterEach(() => {
      delete process.env.WORKFLOW_DEBUG;
      stderrSpy.mockRestore();
    });

    it('includes correlation context in logs', () => {
      const logger = createCorrelatedLogger('test');
      withCorrelation({ correlationId: 'abc-123', runId: 'run-1' }, () => {
        logger('test message');
      });
      const output = stderrSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('cid=abc-123');
      expect(output).toContain('run=run-1');
    });

    it('logs without correlation prefix when no context', () => {
      const logger = createCorrelatedLogger('test');
      logger('test message');
      const output = stderrSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('[test]');
      expect(output).toContain('test message');
      expect(output).not.toContain('cid=');
    });
  });
});
