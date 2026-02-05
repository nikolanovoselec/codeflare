/**
 * Error response patterns used in the application:
 *
 * 1. AppError JSON — Most routes return `{ error, code }` via AppError.toJSON().
 *    Status codes map to subclasses: 400 ValidationError, 401 AuthError,
 *    403 ForbiddenError, 404 NotFoundError, 429 RateLimitError, 500 ContainerError.
 *
 * 2. SetupError JSON — Setup routes return `{ success: false, steps, error, code }`
 *    with per-step progress for the setup wizard UI.
 *
 * 3. Plain text / null body — WebSocket upgrade rejections (e.g., origin not allowed,
 *    rate limit 429) may return plain text or null body with appropriate status codes.
 */
export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public userMessage?: string
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON() {
    return {
      error: this.userMessage || this.message,
      code: this.code,
    };
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      'NOT_FOUND',
      404,
      `${resource} not found${id ? `: ${id}` : ''}`,
      `${resource} not found`
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', 400, message, message);
  }
}

export class ContainerError extends AppError {
  constructor(operation: string, detail?: string) {
    super(
      'CONTAINER_ERROR',
      500,
      `Container ${operation} failed${detail ? `: ${detail}` : ''}`,
      `Container operation failed. Please try again.`
    );
  }
}

export class AuthError extends AppError {
  constructor(message: string = 'Authentication required') {
    super('AUTH_ERROR', 401, message, 'Authentication required');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super('FORBIDDEN', 403, message, 'Access denied');
  }
}

/**
 * Error thrown exclusively from setup routes during initial configuration.
 * Includes step-level progress reporting for the setup wizard UI.
 */
export class SetupError extends AppError {
  public steps: Array<{ step: string; status: string; error?: string }>;

  constructor(message: string, steps: Array<{ step: string; status: string; error?: string }>) {
    super('SETUP_ERROR', 400, message, 'Setup configuration failed');
    this.steps = steps;
  }

  override toJSON() {
    return { success: false, steps: this.steps, error: this.message, code: this.code };
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests') {
    super('RATE_LIMIT_ERROR', 429, message, 'Please slow down and try again.');
  }
}

export class CircuitBreakerOpenError extends AppError {
  constructor(service: string) {
    super('CIRCUIT_BREAKER_OPEN', 503, `Service ${service} is temporarily unavailable`, 'Service temporarily unavailable. Please try again shortly.');
  }
}

/** Convert unknown catch values to Error instances */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Extract error message from unknown catch values */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
