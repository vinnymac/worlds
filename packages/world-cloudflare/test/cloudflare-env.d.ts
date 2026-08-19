// `env` from `cloudflare:test` is typed as `Cloudflare.Env`, which wrangler
// generates into a worker-configuration.d.ts. That generated file is not
// checked in here, so the wrangler.toml bindings the workerd suite reaches for
// are declared by hand. Keep this in sync with [durable_objects] in
// wrangler.toml.
// Typed with the RPC-shaped namespaces the source uses rather than a bare
// DurableObjectNamespace, so the suite typechecks the same stub surface the
// production code calls through.
declare namespace Cloudflare {
  interface Env {
    WORKFLOW_DB: import('../src/storage.js').WorkflowRunDONamespace;
    WORKFLOW_STREAMS: import('../src/streamer.js').StreamDONamespace;
  }
}
