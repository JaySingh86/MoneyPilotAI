import { customType } from "drizzle-orm/pg-core";

/** Case-insensitive text (citext extension). */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/** Raw bytes, e.g. sha256 digests. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
