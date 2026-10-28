export type ErrorStatus =
  400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503;

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: ErrorStatus = 400,
  ) {
    super(message);
  }
}

export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
  status: ErrorStatus = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
