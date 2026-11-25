export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);

    this.name = 'HttpError';
    this.status = status;
  }
}

export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

