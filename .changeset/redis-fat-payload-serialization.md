---
"@fantasticfour/world-redis": patch
"@fantasticfour/world-redis-bullmq": patch
---

Serialize binary payloads in storage as base64 instead of JSON number arrays.
At a 2 MB payload this is ~58x faster to write, ~570x faster to read, and
2.7x smaller on the wire, bringing fat-payload throughput in line with the
upstream reference worlds. Reading data stored in the legacy number-array
format remains supported.
