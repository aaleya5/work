import type { PaginatedResponse } from '../types/api-response';

/**
 * Reusable cursor-free pagination helper.
 *
 * Takes two thunks - one that fetches a page of rows, one that counts the
 * total matching rows - and runs them in parallel, returning a fully typed
 * `PaginatedResponse<T>`.
 *
 * Thunks (rather than a raw Prisma delegate + args object) are used
 * deliberately: each Prisma model delegate's `findMany`/`count` methods are
 * *generic*, with a return type that depends on the exact `select`/`include`
 * passed in. Accepting thunks lets the caller build the precisely-typed
 * Prisma call (with `skip`/`take` already applied) while `paginate` itself
 * stays a simple, fully type-safe generic over `T`.
 *
 * @example
 * ```ts
 * const where: Prisma.CourseWhereInput = { published: true };
 * const skip = (page - 1) * size;
 *
 * const result = await paginate<CourseSearchRecord>(
 *   () => prisma.course.findMany({ where, select: courseSearchSelect, skip, take: size }),
 *   () => prisma.course.count({ where }),
 *   page,
 *   size,
 * );
 * ```
 */
export async function paginate<T>(
  findPage: () => Promise<T[]>,
  countTotal: () => Promise<number>,
  page: number,
  size: number,
): Promise<PaginatedResponse<T>> {
  const [data, total] = await Promise.all([findPage(), countTotal()]);

  return {
    data,
    total,
    page,
    size,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}
