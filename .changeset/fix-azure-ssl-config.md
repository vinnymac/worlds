---
"@fantasticfour/world-azure": patch
---

Fix Azure Cosmos DB emulator test configuration

- Added HTTPS agent configuration to handle emulator's self-signed certificates
- Switched to `:vnext-preview` Docker image tag for ARM64 compatibility (Apple Silicon support)
- Added SSL initialization delay for improved test stability
