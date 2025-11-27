# @fantasticfour/tsconfig

Shared TypeScript configuration for all @fantasticfour packages.

## Configurations

### `base.json`

Common TypeScript settings shared across all packages:
- Strict mode enabled
- ES2022 target and lib
- Declaration files and source maps enabled
- Standard best practices (skipLibCheck, forceConsistentCasingInFileNames, etc.)

### `node.json`

For Node.js packages (extends `base.json`):
- NodeNext module resolution
- Optimized for Node.js runtime
- Used by: world-redis, world-redis-bullmq, world-postgres-redis

### `bundler.json`

For bundler-based packages (extends `base.json`):
- Bundler module resolution
- ES2022 modules
- JSON import support
- Used by: world-postgres-upstash, world-cloudflare, world-dynamodb-sqs, world-firestore-tasks

## Usage

In your package's `tsconfig.json` (for Node.js packages):

```json
{
  "extends": "../tsconfig/node.json",
  "include": ["src"],
  "exclude": ["node_modules", "**/*.test.ts"]
}
```

Or for bundler-based packages:

```json
{
  "extends": "../tsconfig/bundler.json",
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### Adding Package-Specific Overrides

You can override or add additional compiler options:

```json
{
  "extends": "../tsconfig/bundler.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

## Notes

- The `include` and `exclude` arrays must be specified in each package's tsconfig.json as these paths are resolved relative to the package location
- Compiler options are inherited from the base configs but can be overridden as needed
- Use relative paths (`../tsconfig/`) to reference the shared configs
