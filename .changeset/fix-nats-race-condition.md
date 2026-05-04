---
"@fantasticfour/world-nats-jetstream": patch
---

Fix race condition in NATS JetStream storage operations

Fixed `TypeError: Cannot read properties of undefined (reading 'operation')` that occurred during concurrent operations. Added null checks when iterating JetStream KV bucket history to handle undefined entries gracefully. All tests now pass reliably (6/6).
