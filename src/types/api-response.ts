/**
 * Generic API response envelope used by every route handler.
 *
 * Using a discriminated union on `success` lets consumers (and the
 * TypeScript compiler) narrow the shape automatically:
 *
 * ```ts
 * const res: ApiResponse<CourseDto> = ok(course);
 * if (res.success) {
 *   res.data; // CourseDto
 * } else {
 *   res.error.message; // string
 * }
 * ```
 */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** Generic paginated payload returned by list endpoints. */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  size: number;
  totalPages: number;
}

/** Build a successful API envelope. */
export function ok<T>(data: T): ApiSuccessResponse<T> {
  return { success: true, data };
}

/** Build an error API envelope. */
export function fail(message: string, code?: string, details?: unknown): ApiErrorResponse {
  return { success: false, error: { message, code, details } };
}
