import { inspect } from "node:util";

export function syncErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function syncErrorLogDetails(err: unknown): string {
  if (typeof err !== "object" || err === null) {
    return inspect(err, { colors: false, depth: null });
  }

  const record = err as Record<string, unknown>;
  const details: Record<string, unknown> = {};

  if (err instanceof Error) {
    details.name = err.name;
    details.message = err.message;
  } else if ("message" in record) {
    details.message = record.message;
  }

  for (const key of ["kind", "code", "details", "cause"] as const) {
    if (key in record) details[key] = record[key];
  }

  return inspect(
    Object.keys(details).length > 0 ? details : err,
    {
      colors: false,
      compact: false,
      depth: null,
      breakLength: 120,
    },
  );
}

export function wrapSyncOperationError(operation: string, err: unknown): Error {
  const wrapped = new Error(`${operation}: ${syncErrorMessage(err)}`);
  const target = wrapped as Error & {
    cause?: unknown;
    kind?: unknown;
    code?: unknown;
    details?: unknown;
  };
  target.cause = err;

  if (typeof err === "object" && err !== null) {
    if ("kind" in err) target.kind = (err as { kind: unknown }).kind;
    if ("code" in err) target.code = (err as { code: unknown }).code;
    if ("details" in err) target.details = (err as { details: unknown }).details;
  }

  return wrapped;
}
