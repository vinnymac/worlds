---
'@fantasticfour/world-cloudflare': patch
---

`createStreamer` now returns `CloudflareStreamer`, which declares that
`writeToStream` and `closeStream` accept an unresolved `Promise<string>` run id.
Every world already implemented that contract; only the return type hid it.
