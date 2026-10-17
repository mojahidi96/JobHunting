export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: unknown[] = [],
    /** Optional machine-readable extras (e.g. retryAfterSeconds) returned as `error.meta`. */
    public meta?: Record<string, unknown>,
  ) {
    super(message);
  }
}
