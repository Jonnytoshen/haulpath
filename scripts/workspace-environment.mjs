// Kept in child-process environment only: never persist or log the snapshot.
export const snapshotVariable = 'HAULPATH_INTERNAL_CALLER_ENV';

export function callerEnvironment(environment = process.env) {
  const result = environment[snapshotVariable]
    ? JSON.parse(Buffer.from(environment[snapshotVariable], 'base64').toString('utf8'))
    : { ...environment };
  delete result[snapshotVariable];
  return result;
}
