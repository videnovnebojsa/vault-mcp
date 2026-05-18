export enum VaultErrorCode {
  NOT_FOUND = "NOT_FOUND",
  PATH_TRAVERSAL = "PATH_TRAVERSAL",
  ACL_VIOLATION = "ACL_VIOLATION",
  CONFLICT = "CONFLICT",
  VALIDATION = "VALIDATION",
  BOOT_FAILED = "BOOT_FAILED",
  STORE_UNAVAILABLE = "STORE_UNAVAILABLE",
  TIMEOUT = "TIMEOUT",
  EXTERNAL_API = "EXTERNAL_API",
  AUDIT_FAILED = "AUDIT_FAILED",
  CONFIRMATION_REQUIRED = "CONFIRMATION_REQUIRED",
  NOT_ENABLED = "NOT_ENABLED",
  MODE_UNAVAILABLE = "MODE_UNAVAILABLE",
  ALREADY_RUNNING = "ALREADY_RUNNING",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly code: VaultErrorCode,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/** Formats any unknown thrown value into a user-facing string. */
export function formatErrorMessage(err: unknown): string {
  if (err instanceof VaultError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Formats any unknown thrown value into a JSON-serializable object for MCP tool responses. */
export function formatErrorResponse(err: unknown): { error: { code: string; message: string } } {
  if (err instanceof VaultError) {
    return { error: { code: err.code, message: err.message } };
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code ?? "INTERNAL_ERROR";
    return { error: { code, message: err.message } };
  }
  return { error: { code: "INTERNAL_ERROR", message: String(err) } };
}
