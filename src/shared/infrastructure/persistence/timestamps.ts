/**
 * `em.execute` (SQL cru) devolve `timestamptz` como string (ex.: "2026-07-29 15:00:02+00"),
 * não como Date. Os mappers de linhas lidas por SQL cru devem normalizar com esta função.
 */
export function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid timestamp returned by the database: '${String(value)}'`);
  }
  return date;
}

export function toOptionalDate(value: Date | string | null | undefined): Date | undefined {
  return value === null || value === undefined ? undefined : toDate(value);
}
