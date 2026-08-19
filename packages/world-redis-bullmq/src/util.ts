import { createDebugLogger } from '@fantasticfour/shared';

export { compact, Mutex, Rc } from '@fantasticfour/shared';
// `parse`/`stringify` take a fast path that skips JSON's reviver/replacer when
// the payload holds no binary (~5x on parse, ~2x on stringify) with identical
// semantics. It lives in the shared package so every world gets it.
export { hasBinary, parse, stringify } from '@fantasticfour/shared';
export const debug = createDebugLogger('redis-bullmq-world');
