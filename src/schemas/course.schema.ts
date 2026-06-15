import { z } from 'zod';

// ---------------------------------------------------------------------------
// Leaf schemas - composed upward into CourseWithModulesSchema below.
// ---------------------------------------------------------------------------

export const CreateLessonSchema = z.object({
  title: z.string().min(3).max(150),
  content: z.string().min(1),
  videoUrl: z.string().url().optional(),
});
export type CreateLessonDto = z.infer<typeof CreateLessonSchema>;

export const CreateModuleSchema = z.object({
  title: z.string().min(3).max(150),
  lessons: CreateLessonSchema.array().min(1, 'Each module needs at least one lesson'),
});
export type CreateModuleDto = z.infer<typeof CreateModuleSchema>;

// ---------------------------------------------------------------------------
// Course schemas
// ---------------------------------------------------------------------------

export const CreateCourseSchema = z.object({
  title: z.string().min(5).max(100),
  category: z.enum(['PROGRAMMING', 'DESIGN', 'DATA_SCIENCE', 'BUSINESS', 'OTHER']),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']),
  price: z.number().nonnegative().max(99999.99),
});
export type CreateCourseDto = z.infer<typeof CreateCourseSchema>;

/** All fields optional - used for PATCH /courses/:id. */
export const UpdateCourseSchema = CreateCourseSchema.partial();
export type UpdateCourseDto = z.infer<typeof UpdateCourseSchema>;

/**
 * Composed schema for `POST /courses`: a course plus its full module/lesson
 * tree, created atomically. Built by extending `CreateCourseSchema` with a
 * `modules` array of `CreateModuleSchema`, which itself nests
 * `CreateLessonSchema` - three levels of schema composition reused for a
 * single nested DTO.
 */
export const CourseWithModulesSchema = CreateCourseSchema.extend({
  modules: CreateModuleSchema.array().min(1, 'A course needs at least one module'),
});
export type CourseWithModulesDto = z.infer<typeof CourseWithModulesSchema>;

// ---------------------------------------------------------------------------
// Search / filtering
// ---------------------------------------------------------------------------

export const CourseFiltersSchema = z.object({
  category: z.enum(['PROGRAMMING', 'DESIGN', 'DATA_SCIENCE', 'BUSINESS', 'OTHER']).optional(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  search: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});
export type CourseFiltersDto = z.infer<typeof CourseFiltersSchema>;
