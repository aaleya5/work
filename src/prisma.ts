import { PrismaClient, Prisma } from '@prisma/client';
import { env } from './config/env';

/**
 * Models that carry a `deletedAt` column and should be transparently
 * filtered by the soft-delete extension below. Kept as an explicit list
 * (rather than introspecting the Prisma schema at runtime) so the set of
 * soft-deletable models is obvious from a single place and fully typed.
 */
const SOFT_DELETE_MODELS = ['Course'] as const;
type SoftDeleteModel = (typeof SOFT_DELETE_MODELS)[number];

function isSoftDeleteModel(model: string | undefined): model is SoftDeleteModel {
  return !!model && (SOFT_DELETE_MODELS as readonly string[]).includes(model);
}

/**
 * Base (un-extended) client. Soft-deleted rows are NOT filtered on this
 * instance - it exists only so the extension below has something to wrap,
 * and so admin/cleanup tooling can opt out of the filter deliberately by
 * importing `prismaUnfiltered` instead of the default export.
 */
const basePrisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

/**
 * Soft-delete Client Extension (Prisma 5's replacement for the old
 * `$use` middleware API).
 *
 * For every model listed in `SOFT_DELETE_MODELS`, `findMany` / `findFirst`
 * / `count` are rewritten so callers never see rows with a non-null
 * `deletedAt` unless they explicitly ask for them (an explicit
 * `where.deletedAt` passed by the caller is preserved - this only fills in
 * a default, it never overrides one).
 *
 * `findUnique` can't take an arbitrary `deletedAt` filter the same way
 * (Prisma only allows unique fields in its `where`), so the extension
 * runs the query as-is and discards the result if it turns out to be
 * soft-deleted - keeping "not found" behaviour identical to a real delete
 * from the caller's point of view.
 *
 * `delete` / `deleteMany` are intentionally left untouched - the
 * application calls `update({ data: { deletedAt: new Date() } })` instead
 * of a real delete (see `CourseService.delete`).
 */
export const prisma = basePrisma.$extends({
  name: 'soft-delete',
  query: {
    $allModels: {
      async findMany({ model, args, query }) {
        if (isSoftDeleteModel(model)) {
          const where = (args.where ?? {}) as Record<string, unknown>;
          if (where.deletedAt === undefined) {
            args.where = { ...where, deletedAt: null } as typeof args.where;
          }
        }
        return query(args);
      },
      async findFirst({ model, args, query }) {
        if (isSoftDeleteModel(model)) {
          const where = (args.where ?? {}) as Record<string, unknown>;
          if (where.deletedAt === undefined) {
            args.where = { ...where, deletedAt: null } as typeof args.where;
          }
        }
        return query(args);
      },
      async count({ model, args, query }) {
        if (isSoftDeleteModel(model)) {
          const where = (args.where ?? {}) as Record<string, unknown>;
          if (where.deletedAt === undefined) {
            args.where = { ...where, deletedAt: null } as typeof args.where;
          }
        }
        return query(args);
      },
      async findUnique({ model, args, query }) {
        const result = await query(args);
        if (isSoftDeleteModel(model) && result && (result as { deletedAt?: Date | null }).deletedAt) {
          return null;
        }
        return result;
      },
    },
  },
});

/**
 * Escape hatch for tooling that genuinely needs to see soft-deleted rows
 * (admin restore endpoints, data exports, etc). Not used anywhere in the
 * application today, but exported so it doesn't need to be re-derived
 * later.
 */
export const prismaUnfiltered = basePrisma;

export type SoftDeletePrismaClient = typeof prisma;
export { Prisma };
export default prisma;
