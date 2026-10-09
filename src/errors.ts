export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) {
    super(message);
  }
}
export function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new AppError(code, message, status, retryable);
}
