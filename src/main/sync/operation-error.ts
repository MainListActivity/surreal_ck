export function syncErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
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
