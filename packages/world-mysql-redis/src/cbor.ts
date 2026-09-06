import { decode, encode } from 'cbor-x';
import { customType } from 'drizzle-orm/mysql-core';

export { type Cborized } from '@fantasticfour/shared';

export function Cbor<T>() {
  return customType<{ data: T; driverData: Buffer }>({
    dataType: () => 'mediumblob',
    fromDriver: (value) => decode(value),
    toDriver: (value) => encode(value),
  });
}
