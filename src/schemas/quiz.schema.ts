import { z } from 'zod';

// ---------------------------------------------------------------------------
// Quiz creation - composed bottom-up: Option -> Question -> Quiz
// ---------------------------------------------------------------------------

export const CreateOptionSchema = z.object({
  text: z.string().min(1).max(300),
  isCorrect: z.boolean().default(false),
});
export type CreateOptionDto = z.infer<typeof CreateOptionSchema>;

export const CreateQuestionSchema = z.object({
  text: z.string().min(1).max(500),
  options: CreateOptionSchema.array()
    .min(2, 'Each question needs at least two options')
    .refine((opts) => opts.some((o) => o.isCorrect), {
      message: 'Each question must have at least one correct option',
    }),
});
export type CreateQuestionDto = z.infer<typeof CreateQuestionSchema>;

export const CreateQuizSchema = z.object({
  title: z.string().min(3).max(150),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  passScore: z.number().int().min(0).max(100).default(70),
  moduleId: z.string().min(1).optional(),
  questions: CreateQuestionSchema.array().min(1, 'A quiz needs at least one question'),
});
export type CreateQuizDto = z.infer<typeof CreateQuizSchema>;

// ---------------------------------------------------------------------------
// Attempt submission
// ---------------------------------------------------------------------------

export const AnswerSchema = z.object({
  questionId: z.string().min(1),
  selectedOptionId: z.string().min(1),
});
export type AnswerDto = z.infer<typeof AnswerSchema>;

export const SubmitAttemptSchema = z.object({
  answers: AnswerSchema.array().min(1, 'At least one answer is required'),
});
export type SubmitAttemptDto = z.infer<typeof SubmitAttemptSchema>;

/**
 * Result of scoring an attempt. Defined as a discriminated-ish literal
 * union on `status` so callers can branch exhaustively:
 *
 * ```ts
 * if (result.status === 'PASSED') { ... } else { ... }
 * ```
 */
export const AttemptResultSchema = z.object({
  score: z.number().min(0).max(100),
  status: z.enum(['PASSED', 'FAILED']),
  correctCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});
export type AttemptResult = z.infer<typeof AttemptResultSchema>;
