import { z } from 'zod';

/**
 * Standard `:id` route param. EduTrack uses Prisma `cuid()` identifiers,
 * which are non-empty alphanumeric strings - validate as a non-empty
 * string rather than a UUID.
 */
export const IdParamSchema = z.object({
  id: z.string().min(1, 'id is required'),
});
export type IdParamDto = z.infer<typeof IdParamSchema>;

/**
 * Query-string pagination. `page` is 1-indexed. Both fields are coerced
 * from strings since Fastify query params arrive as strings.
 */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQueryDto = z.infer<typeof PaginationQuerySchema>;
