import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../prisma';
import { logger } from '../utils/logger';
import { roundPercentage } from '../utils/math';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableEntityError } from '../errors/app-error';
import type { CompletionStatusDto, ProgressDto } from '../schemas/enrollment.schema';

const log = logger.child({ module: 'EnrollmentService' });

export const enrollmentSelect = Prisma.validator<Prisma.EnrollmentSelect>()({
  id: true,
  userId: true,
  courseId: true,
  enrolledAt: true,
  certificateCode: true,
});

export type EnrollmentDto = Prisma.EnrollmentGetPayload<{ select: typeof enrollmentSelect }>;

export class EnrollmentService {
  /**
   * Enrol a student in a course.
   *
   * Business rules:
   *  - the course must exist and be `published`
   *  - the user must not already be enrolled (enforced at the DB level via
   *    the `@@unique([userId, courseId])` constraint on `Enrollment`, and
   *    surfaced here as a typed 409 `ConflictError`)
   */
  async enroll(userId: string, courseId: string): Promise<EnrollmentDto> {
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, published: true },
    });

    if (!course) {
      throw new NotFoundError('Course', courseId);
    }
    if (!course.published) {
      throw new UnprocessableEntityError('Cannot enroll in an unpublished course', 'COURSE_NOT_PUBLISHED');
    }

    try {
      const enrollment = await prisma.enrollment.create({
        data: { userId, courseId },
        select: enrollmentSelect,
      });

      log.info({ userId, courseId }, 'Student enrolled in course');
      return enrollment;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        log.error({ err, userId, courseId }, 'Enrollment failed: duplicate enrollment');
        throw new ConflictError('You are already enrolled in this course', 'ALREADY_ENROLLED');
      }
      log.error({ err, userId, courseId }, 'Enrollment failed');
      throw err;
    }
  }

  /**
   * Mark a lesson as complete for a user. Idempotent via `upsert` - marking
   * an already-completed lesson complete again is a no-op.
   *
   * Returns the user's updated progress for the lesson's parent course.
   */
  async markLessonComplete(userId: string, lessonId: string): Promise<ProgressDto> {
    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, module: { select: { courseId: true } } },
    });

    if (!lesson) {
      throw new NotFoundError('Lesson', lessonId);
    }

    const courseId = lesson.module.courseId;

    const enrollment = await prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { id: true },
    });

    if (!enrollment) {
      throw new ForbiddenError('You must be enrolled in this course to track lesson progress');
    }

    await prisma.lessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: { userId, lessonId },
      update: {},
    });

    log.info({ userId, lessonId, courseId }, 'Lesson marked complete');
    return this.getProgress(userId, courseId);
  }

  /**
   * Computes `{ totalLessons, completedLessons, percentage }` for a course
   * using a single `$transaction` of two `count` queries.
   */
  async getProgress(userId: string, courseId: string): Promise<ProgressDto> {
    const [totalLessons, completedLessons] = await prisma.$transaction([
      prisma.lesson.count({ where: { module: { courseId } } }),
      prisma.lessonProgress.count({ where: { userId, lesson: { module: { courseId } } } }),
    ]);

    const percentage = totalLessons === 0 ? 0 : roundPercentage(completedLessons, totalLessons);

    return { courseId, totalLessons, completedLessons, percentage };
  }

  /**
   * Determines whether a student has met the criteria for course
   * completion (all lessons watched + all course quizzes passed) and, if
   * so, lazily issues a certificate code.
   *
   * The certificate code is generated with `crypto.randomUUID()` exactly
   * once and persisted on the `Enrollment` row - subsequent calls return
   * the same code.
   */
  async getCompletionStatus(userId: string, enrollmentId: string): Promise<CompletionStatusDto> {
    const enrollment = await prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { id: true, userId: true, courseId: true, certificateCode: true },
    });

    if (!enrollment) {
      throw new NotFoundError('Enrollment', enrollmentId);
    }
    if (enrollment.userId !== userId) {
      throw new ForbiddenError('This enrollment does not belong to you');
    }

    const progress = await this.getProgress(userId, enrollment.courseId);
    const lessonsComplete = progress.totalLessons > 0 && progress.completedLessons === progress.totalLessons;

    const quizzesPassed = await this.hasPassedAllQuizzes(userId, enrollment.courseId);
    const eligible = lessonsComplete && quizzesPassed;

    let certificateCode = enrollment.certificateCode;
    if (eligible && certificateCode === null) {
      certificateCode = randomUUID();
      await prisma.enrollment.update({
        where: { id: enrollmentId },
        data: { certificateCode },
      });
      log.info({ userId, enrollmentId, certificateCode }, 'Certificate issued');
    }

    return { lessonsComplete, quizzesPassed, eligible, certificateCode };
  }

  /** A student "passes all quizzes" if there are none, or they have a PASSED attempt for each. */
  private async hasPassedAllQuizzes(userId: string, courseId: string): Promise<boolean> {
    const totalQuizzes = await prisma.quiz.count({ where: { courseId } });
    if (totalQuizzes === 0) {
      return true;
    }

    const passedQuizzes = await prisma.quizAttempt.findMany({
      where: { userId, status: 'PASSED', quiz: { courseId } },
      distinct: ['quizId'],
      select: { quizId: true },
    });

    return passedQuizzes.length >= totalQuizzes;
  }
}

export const enrollmentService = new EnrollmentService();
