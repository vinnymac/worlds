/**
 * Cloudflare Worker entry point
 * Exports Durable Object classes for workflow execution
 */

export { StreamDO } from './durable-objects/StreamDO.js';
// Export Durable Object classes
export { WorkflowRunDO } from './durable-objects/WorkflowRunDO.js';

/**
 * Worker fetch handler
 * This worker is primarily a library, but we need a fetch handler for wrangler
 */
export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response('Cloudflare World - Library for workflow execution', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
