import { Prisma } from '@prisma/client';
import prisma from '../prisma';
import { logger } from '../utils/logger';
import { ConflictError, NotFoundError, UnprocessableEntityError } from '../errors/app-error';
import type { AnswerDto, AttemptResult, CreateQuizDto } from '../schemas/quiz.schema';

const log = logger.child({ module: 'QuizService' });

// ---------------------------------------------------------------------------
// Student-facing select - `isCorrect` is intentionally NOT selected so the
// answer key can never leak before an attempt is submitted.
// ---------------------------------------------------------------------------

export const quizForStudentSelect = Prisma.validator<Prisma.QuizSelect>()({
  id: true,
  title: true,
  maxAttempts: true,
  passScore: true,
  courseId: true,
  questions: {
    select: {
      id: true,
      text: true,
      options: {
        select: {
          id: true,
          text: true,
          // isCorrect deliberately omitted
        },
      },
    },
  },
});

export type QuizForStudentDto = Prisma.QuizGetPayload<{ select: typeof quizForStudentSelect }>;

// ---------------------------------------------------------------------------
// Discriminated union describing why an attempt may be rejected, used
// internally to decide which AppError subtype/status code to throw.
// ---------------------------------------------------------------------------

type AttemptValidationFailure =
  | { type: 'ALREADY_PASSED' }
  | { type: 'MAX_ATTEMPTS_EXCEEDED'; maxAttempts: number; attemptsUsed: number };

export class QuizService {
  /** Fetch a quiz for a student, omitting the answer key (`Option.isCorrect`). */
  async getQuizForStudent(quizId: string): Promise<QuizForStudentDto> {
    const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, select: quizForStudentSelect });
    if (!quiz) {
      throw new NotFoundError('Quiz', quizId);
    }
    return quiz;
  }

  /**
   * Creates a quiz with its full question/option tree atomically.
   */
  async createQuiz(courseId: string, dto: CreateQuizDto) {
    const quiz = await prisma.$transaction((tx) =>
      tx.quiz.create({
        data: {
          title: dto.title,
          maxAttempts: dto.maxAttempts,
          passScore: dto.passScore,
          courseId,
          moduleId: dto.moduleId,
          questions: {
            create: dto.questions.map((question) => ({
              text: question.text,
              options: {
                create: question.options.map((option) => ({
                  text: option.text,
                  isCorrect: option.isCorrect,
                })),
              },
            })),
          },
        },
        select: { id: true, title: true, courseId: true },
      }),
    );

    log.info({ quizId: quiz.id, courseId, questionCount: dto.questions.length }, 'Quiz created');
    return quiz;
  }

  /**
   * Scores a quiz attempt.
   *
   * Flow:
   *  1. Load the quiz with `include: { questions: { include: { options: true } } }`
   *     (the full answer key - this is server-side only).
   *  2. Validate the user hasn't already passed and hasn't exhausted
   *     `maxAttempts`.
   *  3. Map submitted answers to a `Map<questionId, selectedOptionId>` and
   *     check each question's selected option for `isCorrect`.
   *  4. Persist the attempt and return a typed `AttemptResult`.
   */
  async submitAttempt(userId: string, quizId: string, answers: AnswerDto[]): Promise<AttemptResult> {
    const quiz = await prisma.quiz.findUnique({
      where: { id: quizId },
      include: { questions: { include: { options: true } } },
    });

    if (!quiz) {
      throw new NotFoundError('Quiz', quizId);
    }

    const previousAttempts = await prisma.quizAttempt.findMany({
      where: { userId, quizId },
      select: { status: true },
    });

    const failure = this.validateAttempt(previousAttempts, quiz.maxAttempts);
    if (failure) {
      throw this.toAppError(failure);
    }

    const answerMap = new Map<string, string>(answers.map((answer) => [answer.questionId, answer.selectedOptionId]));

    let correctCount = 0;
    for (const question of quiz.questions) {
      const selectedOptionId = answerMap.get(question.id);
      if (selectedOptionId === undefined) {
        continue;
      }
      const selectedOption = question.options.find((option) => option.id === selectedOptionId);
      if (selectedOption?.isCorrect === true) {
        correctCount += 1;
      }
    }

    const totalCount = quiz.questions.length;
    const score = totalCount === 0 ? 0 : roundPercentage(correctCount, totalCount);
    const status: AttemptResult['status'] = score >= quiz.passScore ? 'PASSED' : 'FAILED';

    await prisma.quizAttempt.create({
      data: { userId, quizId, score, status, correctCount, totalCount },
    });

    log.info({ userId, quizId, score, status, correctCount, totalCount }, 'Quiz attempt submitted');

    return { score, status, correctCount, totalCount };
  }

  private validateAttempt(
    previousAttempts: Array<{ status: 'PASSED' | 'FAILED' }>,
    maxAttempts: number,
  ): AttemptValidationFailure | null {
    if (previousAttempts.some((attempt) => attempt.status === 'PASSED')) {
      return { type: 'ALREADY_PASSED' };
    }
    if (previousAttempts.length >= maxAttempts) {
      return { type: 'MAX_ATTEMPTS_EXCEEDED', maxAttempts, attemptsUsed: previousAttempts.length };
    }
    return null;
  }

  private toAppError(failure: AttemptValidationFailure): ConflictError | UnprocessableEntityError {
    switch (failure.type) {
      case 'ALREADY_PASSED':
        return new ConflictError('Quiz already passed', 'QUIZ_ALREADY_PASSED');
      case 'MAX_ATTEMPTS_EXCEEDED':
        return new UnprocessableEntityError('Max attempts exceeded', 'MAX_ATTEMPTS_EXCEEDED');
    }
  }
}

function roundPercentage(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10000) / 100;
}

export const quizService = new QuizService();
