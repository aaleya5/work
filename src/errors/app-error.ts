/**
 * Typed application error. Thrown by services for any expected, user-facing
 * failure (validation, business-rule violations, not-found, conflicts...).
 *
 * The Fastify `setErrorHandler` (see `src/plugins/error-handler.plugin.ts`)
 * catches instances of this class and maps them directly to an HTTP
 * response using `statusCode`.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;

    // Required when extending built-ins and targeting ES2015+ with some
    // transpilation targets, keeps `instanceof AppError` reliable.
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** 404 - resource does not exist. */
export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    const message = identifier
      ? `${resource} with id '${identifier}' was not found`
      : `${resource} was not found`;
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/** 409 - request conflicts with current state (duplicates, already-passed quiz, etc). */
export class ConflictError extends AppError {
  constructor(message: string, code?: string) {
    super(message, 409, code ?? 'CONFLICT');
    this.name = 'ConflictError';
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/** 422 - request is well-formed but violates a business rule. */
export class UnprocessableEntityError extends AppError {
  constructor(message: string, code?: string) {
    super(message, 422, code ?? 'UNPROCESSABLE_ENTITY');
    this.name = 'UnprocessableEntityError';
    Object.setPrototypeOf(this, UnprocessableEntityError.prototype);
  }
}

/** 401 - missing/invalid credentials. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

/** 403 - authenticated but not allowed to perform this action. */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}
