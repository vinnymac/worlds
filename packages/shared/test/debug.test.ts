import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebugLogger } from '../src/debug.js';

describe('createDebugLogger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    delete process.env.WORKFLOW_DEBUG;
    stderrSpy.mockRestore();
  });

  it('does not log when WORKFLOW_DEBUG is unset', () => {
    const debug = createDebugLogger('test');
    debug('hello');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('logs to stderr when WORKFLOW_DEBUG=1', () => {
    process.env.WORKFLOW_DEBUG = '1';
    const debug = createDebugLogger('test');
    debug('hello');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[test]'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('hello'));
  });

  it('logs when WORKFLOW_DEBUG=true', () => {
    process.env.WORKFLOW_DEBUG = 'true';
    const debug = createDebugLogger('test');
    debug('hello');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('logs when WORKFLOW_DEBUG=*', () => {
    process.env.WORKFLOW_DEBUG = '*';
    const debug = createDebugLogger('test');
    debug('hello');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('filters by namespace', () => {
    process.env.WORKFLOW_DEBUG = 'redis-world';
    const debug = createDebugLogger('mysql-world');
    debug('should not log');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('logs matching namespace', () => {
    process.env.WORKFLOW_DEBUG = 'mysql-world';
    const debug = createDebugLogger('mysql-world');
    debug('should log');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('supports comma-separated namespaces', () => {
    process.env.WORKFLOW_DEBUG = 'redis-world,mysql-world';
    const mysqlDebug = createDebugLogger('mysql-world');
    const redisDebug = createDebugLogger('redis-world');
    const azureDebug = createDebugLogger('azure-world');

    mysqlDebug('mysql');
    redisDebug('redis');
    azureDebug('azure');

    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('serializes objects as JSON', () => {
    process.env.WORKFLOW_DEBUG = '1';
    const debug = createDebugLogger('test');
    debug('Created', { id: '123', status: 'pending' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('"id": "123"'));
  });

  it('includes ISO timestamp', () => {
    process.env.WORKFLOW_DEBUG = '1';
    const debug = createDebugLogger('test');
    debug('hello');
    const output = stderrSpy.mock.calls[0]?.[0] as string;
    // Verify ISO timestamp format
    expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
