/**
 * EnrollmentService unit tests
 *
 * Covers: enroll (4 cases), markLessonComplete (3 cases),
 * getProgress (4 cases), getCompletionStatus (5 cases) = 16 total.
 */

import { EnrollmentService } from '../../src/services/enrollment.service';
import prisma from '../../src/prisma';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableEntityError } from '../../src/errors/app-error';
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
    // $transaction is called two ways in EnrollmentService:
    //   • array form:    $transaction([promise, promise]) → awaits all
    //   • callback form: $transaction(fn) → calls fn(tx) [not used here]
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : Promise.resolve(null),
    ),
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
  let svc: EnrollmentService;
  beforeEach(() => { svc = new EnrollmentService(); jest.clearAllMocks(); });

  it('(a) throws NotFoundError 404 when the course does not exist', async () => {
    db.course.findUnique.mockResolvedValue(null);
    await expect(svc.enroll('u1', 'c-bad')).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.enroll('u1', 'c-bad')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('(b) throws UnprocessableEntityError 422 when the course is unpublished', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'c1', published: false });
    await expect(svc.enroll('u1', 'c1')).rejects.toBeInstanceOf(UnprocessableEntityError);
    await expect(svc.enroll('u1', 'c1')).rejects.toMatchObject({ statusCode: 422, code: 'COURSE_NOT_PUBLISHED' });
  });

  it('(c) creates and returns an enrollment for a published course', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'c1', published: true });
    const enrollment = { id: 'e1', userId: 'u1', courseId: 'c1', enrolledAt: new Date(), certificateCode: null };
    db.enrollment.create.mockResolvedValue(enrollment);
    const result = await svc.enroll('u1', 'c1');
    expect(result.id).toBe('e1');
    expect(db.enrollment.create).toHaveBeenCalledTimes(1);
  });

  it('(d) throws ConflictError 409 on P2002 unique constraint (duplicate enrollment)', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'c1', published: true });
    db.enrollment.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique', { code: 'P2002', clientVersion: '5.x' }),
    );
    await expect(svc.enroll('u1', 'c1')).rejects.toBeInstanceOf(ConflictError);
    await expect(svc.enroll('u1', 'c1')).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_ENROLLED' });
  });
});

// ---------------------------------------------------------------------------
// markLessonComplete()
// ---------------------------------------------------------------------------
describe('EnrollmentService.markLessonComplete', () => {
  let svc: EnrollmentService;
  beforeEach(() => { svc = new EnrollmentService(); jest.clearAllMocks(); });

  it('(a) throws NotFoundError 404 when the lesson does not exist', async () => {
    db.lesson.findUnique.mockResolvedValue(null);
    await expect(svc.markLessonComplete('u1', 'l-bad')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('(b) throws ForbiddenError 403 when the user is not enrolled in the lesson\'s course', async () => {
    db.lesson.findUnique.mockResolvedValue({ id: 'l1', module: { courseId: 'c1' } });
    db.enrollment.findUnique.mockResolvedValue(null);
    await expect(svc.markLessonComplete('u1', 'l1')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(svc.markLessonComplete('u1', 'l1')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('(c) upserts progress and returns updated percentage', async () => {
    db.lesson.findUnique.mockResolvedValue({ id: 'l1', module: { courseId: 'c1' } });
    db.enrollment.findUnique.mockResolvedValue({ id: 'e1' });
    db.lessonProgress.upsert.mockResolvedValue({});
    db.lesson.count.mockResolvedValue(4);
    db.lessonProgress.count.mockResolvedValue(2);
    const result = await svc.markLessonComplete('u1', 'l1');
    expect(result.percentage).toBe(50);
    expect(result.totalLessons).toBe(4);
    expect(result.completedLessons).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getProgress()
// ---------------------------------------------------------------------------
describe('EnrollmentService.getProgress', () => {
  let svc: EnrollmentService;
  beforeEach(() => { svc = new EnrollmentService(); jest.clearAllMocks(); });

  it('(a) returns 0% when no lessons are completed', async () => {
    db.lesson.count.mockResolvedValue(4);
    db.lessonProgress.count.mockResolvedValue(0);
    const r = await svc.getProgress('u1', 'c1');
    expect(r.percentage).toBe(0);
    expect(r.completedLessons).toBe(0);
  });

  it('(b) returns 100% when all lessons are completed', async () => {
    db.lesson.count.mockResolvedValue(3);
    db.lessonProgress.count.mockResolvedValue(3);
    const r = await svc.getProgress('u1', 'c1');
    expect(r.percentage).toBe(100);
  });

  it('(c) returns 0% (not NaN) when the course has no lessons', async () => {
    db.lesson.count.mockResolvedValue(0);
    db.lessonProgress.count.mockResolvedValue(0);
    const r = await svc.getProgress('u1', 'c1');
    expect(r.percentage).toBe(0);
    expect(Number.isNaN(r.percentage)).toBe(false);
  });

  it('(d) rounds 1/3 to 33.33 — uses shared roundPercentage util', async () => {
    db.lesson.count.mockResolvedValue(3);
    db.lessonProgress.count.mockResolvedValue(1);
    const r = await svc.getProgress('u1', 'c1');
    expect(r.percentage).toBe(33.33);
  });
});

// ---------------------------------------------------------------------------
// getCompletionStatus()
// ---------------------------------------------------------------------------
describe('EnrollmentService.getCompletionStatus', () => {
  let svc: EnrollmentService;
  beforeEach(() => { svc = new EnrollmentService(); jest.clearAllMocks(); });

  it('(a) throws NotFoundError 404 when the enrollment does not exist', async () => {
    db.enrollment.findUnique.mockResolvedValue(null);
    await expect(svc.getCompletionStatus('u1', 'e-bad')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('(b) throws ForbiddenError 403 when the enrollment belongs to another user', async () => {
    db.enrollment.findUnique.mockResolvedValue({ id: 'e1', userId: 'other', courseId: 'c1', certificateCode: null });
    await expect(svc.getCompletionStatus('u1', 'e1')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('(c) returns eligible=false when lessons are incomplete', async () => {
    db.enrollment.findUnique.mockResolvedValue({ id: 'e1', userId: 'u1', courseId: 'c1', certificateCode: null });
    db.lesson.count.mockResolvedValue(3);
    db.lessonProgress.count.mockResolvedValue(1);
    db.quiz.count.mockResolvedValue(0);
    const s = await svc.getCompletionStatus('u1', 'e1');
    expect(s.eligible).toBe(false);
    expect(s.lessonsComplete).toBe(false);
    expect(s.certificateCode).toBeNull();
    expect(db.enrollment.update).not.toHaveBeenCalled();
  });

  it('(d) returns eligible=true and generates a UUID certificate when all criteria are met', async () => {
    db.enrollment.findUnique.mockResolvedValue({ id: 'e1', userId: 'u1', courseId: 'c1', certificateCode: null });
    db.lesson.count.mockResolvedValue(2);
    db.lessonProgress.count.mockResolvedValue(2);
    db.quiz.count.mockResolvedValue(0);
    db.enrollment.update.mockResolvedValue({});
    const s = await svc.getCompletionStatus('u1', 'e1');
    expect(s.eligible).toBe(true);
    expect(s.certificateCode).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(db.enrollment.update).toHaveBeenCalledTimes(1);
  });

  it('(e) does NOT regenerate the certificate if one already exists (immutable code)', async () => {
    const code = 'existing-cert-code-1234';
    db.enrollment.findUnique.mockResolvedValue({ id: 'e1', userId: 'u1', courseId: 'c1', certificateCode: code });
    db.lesson.count.mockResolvedValue(2);
    db.lessonProgress.count.mockResolvedValue(2);
    db.quiz.count.mockResolvedValue(0);
    const s = await svc.getCompletionStatus('u1', 'e1');
    expect(s.certificateCode).toBe(code);
    expect(db.enrollment.update).not.toHaveBeenCalled();
  });
});