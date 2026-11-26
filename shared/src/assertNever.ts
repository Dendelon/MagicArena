/**
 * Exhaustive-check helper ensuring a discriminated union branch narrows to `never` at compile time
 * while formatting any unexpected runtime value safely without interpolating `never`.
 */
export const assertNever = (value: never, prefix: string): never => {
  const detail: unknown = value;
  const serialized =
    typeof detail === 'string' ? detail : JSON.stringify(detail);

  throw new Error(`${prefix}: ${serialized}`);
};

