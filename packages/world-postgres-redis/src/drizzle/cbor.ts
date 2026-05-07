import { decode, encode } from 'cbor-x';
import { customType } from 'drizzle-orm/pg-core';

export { type Cborized } from '@fantasticfour/shared';

export function Cbor<T>() {
  return customType<{ data: T; driverData: Buffer }>({
    dataType: () => 'bytea',
    fromDriver: (value) => decode(value),
    toDriver: (value) => encode(value),
  });
}
