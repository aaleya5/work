import { z } from 'zod';

export const EnrollSchema = z.object({
  courseId: z.string().min(1, 'courseId is required'),
});
export type EnrollDto = z.infer<typeof EnrollSchema>;

export const MarkLessonCompleteParamsSchema = z.object({
  lessonId: z.string().min(1, 'lessonId is required'),
});
export type MarkLessonCompleteParamsDto = z.infer<typeof MarkLessonCompleteParamsSchema>;

/** Returned by `EnrollmentService.markLessonComplete`. */
export const ProgressSchema = z.object({
  courseId: z.string(),
  totalLessons: z.number().int().nonnegative(),
  completedLessons: z.number().int().nonnegative(),
  percentage: z.number().min(0).max(100),
});
export type ProgressDto = z.infer<typeof ProgressSchema>;

/** Returned by `EnrollmentService.getCompletionStatus`. */
export const CompletionStatusSchema = z.object({
  lessonsComplete: z.boolean(),
  quizzesPassed: z.boolean(),
  eligible: z.boolean(),
  certificateCode: z.string().nullable(),
});
export type CompletionStatusDto = z.infer<typeof CompletionStatusSchema>;
