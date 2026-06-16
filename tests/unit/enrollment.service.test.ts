/**
 * EnrollmentService unit tests
 *
 * Covers the core business rules:
 *   - cannot enroll in unpublished course
 *   - duplicate enroll (P2002) → ConflictError 409
 *   - markLessonComplete requires enrollment
 *   - getProgress returns correct percentage
 *   - getCompletionStatus issues and freezes certificate code
 */

import { EnrollmentService } from '../../src/services/enrollment.service';
import prisma from '../../src/prisma';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from '../../src/errors/app-error';
import { Prisma } from '@prisma/client';

jest.mock('../../src/prisma', () => ({
  __esModule: true,
  default: {
    course: { findUnique: jest.fn() },
    enrollment: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    lesson: { findUnique: jest.fn(), count: jest.fn() },
    lessonProgress: { upsert: jest.fn(), count: jest.fn() },
    quiz: { count: jest.fn() },
    quizAttempt: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));

type MockedPrisma = {
  course: { findUnique: jest.Mock };
  enrollment: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  lesson: { findUnique: jest.Mock; count: jest.Mock };
  lessonProgress: { upsert: jest.Mock; count: jest.Mock };
  quiz: { count: jest.Mock };
  quizAttempt: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

const db = prisma as unknown as MockedPrisma;

// ---------------------------------------------------------------------------
// enroll()
// ---------------------------------------------------------------------------

describe('EnrollmentService.enroll', () => {
  let service: EnrollmentService;

  beforeEach(() => {
    service = new EnrollmentService();
    jest.clearAllMocks();
  });

  it('throws NotFoundError (404) when the course does not exist', async () => {
    db.course.findUnique.mockResolvedValue(null);
    await expect(service.enroll('user-1', 'course-x')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.enroll('user-1', 'course-x')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws UnprocessableEntityError (422) when the course is not published', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'course-1', published: false });
    await expect(service.enroll('user-1', 'course-1')).rejects.toBeInstanceOf(UnprocessableEntityError);
    await expect(service.enroll('user-1', 'course-1')).rejects.toMatchObject({ statusCode: 422 });
  });

  it('creates and returns an enrollment when the course is published', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'course-1', published: true });
    const enrollment = { id: 'enroll-1', userId: 'user-1', courseId: 'course-1', enrolledAt: new Date(), certificateCode: null };
    db.enrollment.create.mockResolvedValue(enrollment);

    const result = await service.enroll('user-1', 'course-1');
    expect(result.id).toBe('enroll-1');
    expect(db.enrollment.create).toHaveBeenCalledTimes(1);
  });

  it('throws ConflictError (409) on duplicate enrollment (Prisma P2002)', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'course-1', published: true });
    db.enrollment.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: '5.x' }),
    );
    await expect(service.enroll('user-1', 'course-1')).rejects.toBeInstanceOf(ConflictError);
    await expect(service.enroll('user-1', 'course-1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// markLessonComplete()
// ---------------------------------------------------------------------------

describe('EnrollmentService.markLessonComplete', () => {
  let service: EnrollmentService;

  beforeEach(() => {
    service = new EnrollmentService();
    jest.clearAllMocks();
  });

  it('throws NotFoundError (404) when the lesson does not exist', async () => {
    db.lesson.findUnique.mockResolvedValue(null);
    await expect(service.markLessonComplete('user-1', 'lesson-x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ForbiddenError (403) when the user is not enrolled in the lesson\'s course', async () => {
    db.lesson.findUnique.mockResolvedValue({ id: 'lesson-1', module: { courseId: 'course-1' } });
    db.enrollment.findUnique.mockResolvedValue(null); // not enrolled
    await expect(service.markLessonComplete('user-1', 'lesson-1')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.markLessonComplete('user-1', 'lesson-1')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('upserts progress and returns updated progress on success', async () => {
    db.lesson.findUnique.mockResolvedValue({ id: 'lesson-1', module: { courseId: 'course-1' } });
    db.enrollment.findUnique.mockResolvedValue({ id: 'enroll-1' });
    db.lessonProgress.upsert.mockResolvedValue({});
    db.$transaction.mockResolvedValue([2, 1]); // 2 total, 1 completed

    const progress = await service.markLessonComplete('user-1', 'lesson-1');

    expect(db.lessonProgress.upsert).toHaveBeenCalledTimes(1);
    expect(progress.totalLessons).toBe(2);
    expect(progress.completedLessons).toBe(1);
    expect(progress.percentage).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// getProgress()
// ---------------------------------------------------------------------------

describe('EnrollmentService.getProgress', () => {
  let service: EnrollmentService;

  beforeEach(() => {
    service = new EnrollmentService();
    jest.clearAllMocks();
  });

  it('returns 0% when no lessons are completed', async () => {
    db.$transaction.mockResolvedValue([4, 0]);
    const progress = await service.getProgress('user-1', 'course-1');
    expect(progress.percentage).toBe(0);
    expect(progress.completedLessons).toBe(0);
    expect(progress.totalLessons).toBe(4);
  });

  it('returns 100% when all lessons are completed', async () => {
    db.$transaction.mockResolvedValue([3, 3]);
    const progress = await service.getProgress('user-1', 'course-1');
    expect(progress.percentage).toBe(100);
  });

  it('returns 0% (not NaN) when the course has no lessons', async () => {
    db.$transaction.mockResolvedValue([0, 0]);
    const progress = await service.getProgress('user-1', 'course-1');
    expect(progress.percentage).toBe(0);
    expect(Number.isNaN(progress.percentage)).toBe(false);
  });

  it('rounds fractional percentages correctly (1/3 = 33.33)', async () => {
    db.$transaction.mockResolvedValue([3, 1]);
    const progress = await service.getProgress('user-1', 'course-1');
    expect(progress.percentage).toBe(33.33);
  });
});

// ---------------------------------------------------------------------------
// getCompletionStatus()
// ---------------------------------------------------------------------------

describe('EnrollmentService.getCompletionStatus', () => {
  let service: EnrollmentService;

  beforeEach(() => {
    service = new EnrollmentService();
    jest.clearAllMocks();
  });

  it('throws NotFoundError (404) when the enrollment does not exist', async () => {
    db.enrollment.findUnique.mockResolvedValue(null);
    await expect(service.getCompletionStatus('user-1', 'enroll-x')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ForbiddenError (403) when the enrollment belongs to a different user', async () => {
    db.enrollment.findUnique.mockResolvedValue({ id: 'enroll-1', userId: 'other-user', courseId: 'course-1', certificateCode: null });
    await expect(service.getCompletionStatus('user-1', 'enroll-1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns eligible=false when lessons are incomplete', async () => {
    db.enrollment.findUnique.mockResolvedValue({ id: 'enroll-1', userId: 'user-1', courseId: 'course-1', certificateCode: null });
    db.$transaction.mockResolvedValue([3, 1]); // 3 total, only 1 done
    db.quiz.count.mockResolvedValue(0);

    const status = await service.getCompletionStatus('user-1', 'enroll-1');
    expect(status.eligible).toBe(false);
    expect(status.lessonsComplete).toBe(false);
    expect(status.certificateCode).toBeNull();
  });

  it('returns eligible=true and generates a certificate code when all criteria are met', async () => {
    db.enrollment.findUnique.mockResolvedValue({ id: 'enroll-1', userId: 'user-1', courseId: 'course-1', certificateCode: null });
    db.$transaction.mockResolvedValue([2, 2]); // all lessons done
    db.quiz.count.mockResolvedValue(0);        // no quizzes
    db.enrollment.update.mockResolvedValue({});

    const status = await service.getCompletionStatus('user-1', 'enroll-1');

    expect(status.eligible).toBe(true);
    expect(status.certificateCode).not.toBeNull();
    expect(typeof status.certificateCode).toBe('string');
    // Once issued, update must be called to persist the code
    expect(db.enrollment.update).toHaveBeenCalledTimes(1);
  });

  it('does NOT regenerate a certificate code when one already exists', async () => {
    const existingCode = 'existing-uuid-1234';
    db.enrollment.findUnique.mockResolvedValue({ id: 'enroll-1', userId: 'user-1', courseId: 'course-1', certificateCode: existingCode });
    db.$transaction.mockResolvedValue([2, 2]);
    db.quiz.count.mockResolvedValue(0);

    const status = await service.getCompletionStatus('user-1', 'enroll-1');

    expect(status.certificateCode).toBe(existingCode);
    // No update call — code was already set
    expect(db.enrollment.update).not.toHaveBeenCalled();
  });
});
