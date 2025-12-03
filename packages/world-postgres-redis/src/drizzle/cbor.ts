import { decode, encode } from 'cbor-x';
import { customType } from 'drizzle-orm/pg-core';

export function Cbor<T>() {
  return customType<{ data: T; driverData: Buffer }>({
    dataType: () => 'bytea',
    fromDriver: (value) => decode(value),
    toDriver: (value) => encode(value),
  });
}

export type Cborized<V extends object, K extends keyof V> = V & {
  [key in `${Extract<K, string>}Json`]: unknown;
};
