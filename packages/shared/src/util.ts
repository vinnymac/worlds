export class Mutex {
  promise: Promise<unknown> = Promise.resolve();
  andThen<T>(fn: () => Promise<T> | T): Promise<T> {
    this.promise = this.promise.then(
      () => fn(),
      () => fn(),
    );
    return this.promise as Promise<T>;
  }
}

export function compact<T extends object>(obj: T) {
  const value = {} as {
    [key in keyof T]: null extends T[key] ? undefined | NonNullable<T[key]> : T[key];
  };
  for (const key in obj) {
    if (obj[key] !== null) {
      value[key] = obj[key] as any;
    } else {
      value[key] = undefined as any;
    }
  }
  return value;
}

/**
 * Reference counting helper for managing resource lifecycle
 */
export class Rc {
  private count = 0;
  private disposeFn?: () => void | Promise<void>;

  constructor(disposeFn?: () => void | Promise<void>) {
    this.disposeFn = disposeFn;
  }

  inc(): void {
    this.count++;
  }

  async dec(): Promise<void> {
    this.count--;
    if (this.count === 0 && this.disposeFn) {
      await this.disposeFn();
    }
  }

  getCount(): number {
    return this.count;
  }
}

/**
 * Replaces every Node `Buffer` in a decoded value with a plain `Uint8Array`
 * over the same bytes. Drivers and cbor-x hand back Buffers, and the runtime
 * checks serialized payloads by exact type, so a Buffer where a Uint8Array
 * belongs reads as a value it does not recognize.
 */
export function toPlainBytes<T>(value: T): T {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength) as T;
  }
  if (Array.isArray(value)) {
    return value.map(toPlainBytes) as T;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toPlainBytes(v);
    return out as T;
  }
  return value;
}
