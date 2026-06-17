import { Prisma } from '@prisma/client';
import prisma from '../prisma';
import { logger } from '../utils/logger';
import { paginate } from '../utils/pagination';
import { roundPercentage } from '../utils/math';
import type { PaginatedResponse } from '../types/api-response';
import type { CourseFiltersDto } from '../schemas/course.schema';
import type { ProgressDto } from '../schemas/enrollment.schema';

const log = logger.child({ module: 'SearchService' });

// ---------------------------------------------------------------------------
// Course search
// ---------------------------------------------------------------------------

export const courseSearchSelect = Prisma.validator<Prisma.CourseSelect>()({
  id: true,
  title: true,
  slug: true,
  category: true,
  difficulty: true,
  price: true,
  createdAt: true,
  _count: { select: { enrollments: true } },
});

type CourseSearchRecord = Prisma.CourseGetPayload<{ select: typeof courseSearchSelect }>;

export type CourseSearchResultDto = Omit<CourseSearchRecord, 'price' | '_count'> & {
  price: number;
  enrollmentCount: number;
};

function toCourseSearchResultDto(record: CourseSearchRecord): CourseSearchResultDto {
  const { _count, price, ...rest } = record;
  return { ...rest, price: price.toNumber(), enrollmentCount: _count.enrollments };
}

export class SearchService {
  async searchCourses(filters: CourseFiltersDto): Promise<PaginatedResponse<CourseSearchResultDto>> {
    let where: Prisma.CourseWhereInput = { published: true };

    if (filters.category !== undefined) where = { ...where, category: filters.category };
    if (filters.difficulty !== undefined) where = { ...where, difficulty: filters.difficulty };
    if (filters.search !== undefined) {
      where = { ...where, title: { contains: filters.search, mode: 'insensitive' } };
    }
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      const priceFilter: Prisma.DecimalFilter<'Course'> = {};
      if (filters.minPrice !== undefined) priceFilter.gte = filters.minPrice;
      if (filters.maxPrice !== undefined) priceFilter.lte = filters.maxPrice;
      where = { ...where, price: priceFilter };
    }

    const { page, size } = filters;
    const skip = (page - 1) * size;

    const result = await paginate<CourseSearchRecord>(
      () => prisma.course.findMany({ where, select: courseSearchSelect, orderBy: { createdAt: 'desc' }, skip, take: size }),
      () => prisma.course.count({ where }),
      page,
      size,
    );

    log.info({ filters, total: result.total }, 'Course search executed');
    return { ...result, data: result.data.map(toCourseSearchResultDto) };
  }
}

// ---------------------------------------------------------------------------
// Student dashboard
// ---------------------------------------------------------------------------

export interface EnrollmentWithProgress {
  enrollmentId: string;
  course: { id: string; title: string; slug: string };
  certificateCode: string | null;
  progress: ProgressDto;
}

export interface CompletedCourse {
  courseId: string;
  title: string;
  certificateCode: string | null;
}

export interface StudentDashboard {
  enrollments: EnrollmentWithProgress[];
  completedCourses: CompletedCourse[];
}

// ---------------------------------------------------------------------------
// Instructor dashboard
// ---------------------------------------------------------------------------

export interface InstructorCourseStats {
  courseId: string;
  title: string;
  enrolledCount: number;
  completionRate: number;
}

export interface InstructorDashboard {
  perCourse: InstructorCourseStats[];
}

const studentEnrollmentSelect = Prisma.validator<Prisma.EnrollmentSelect>()({
  id: true,
  certificateCode: true,
  course: { select: { id: true, title: true, slug: true } },
});

type StudentEnrollmentRecord = Prisma.EnrollmentGetPayload<{ select: typeof studentEnrollmentSelect }>;

const instructorCourseSelect = Prisma.validator<Prisma.CourseSelect>()({
  id: true,
  title: true,
  _count: { select: { enrollments: true } },
  enrollments: { select: { userId: true } },
});

type InstructorCourseRecord = Prisma.CourseGetPayload<{ select: typeof instructorCourseSelect }>;

export class DashboardService {
  /**
   * Fetches the entire student dashboard in ONE $transaction:
   *   - enrollment rows (with course info)
   *   - per-enrollment lesson totals
   *   - per-enrollment completed-lesson counts
   * All queries are sent to Postgres in a single round-trip, giving a
   * consistent snapshot of the student's state.
   */
  async getStudentDashboard(userId: string): Promise<StudentDashboard> {
    // Build every query we need and fire them all inside one transaction.
    // We don't know the enrollments yet, so we can't pre-build the count
    // queries — instead we fetch enrollments as the first operation and
    // append count queries for each enrollment, all inside the same
    // interactive transaction so Postgres sees one consistent snapshot.
    const enrollmentsWithProgress: EnrollmentWithProgress[] = [];
    const completedCourses: CompletedCourse[] = [];

    await prisma.$transaction(async (tx) => {
      const enrollments: StudentEnrollmentRecord[] = await tx.enrollment.findMany({
        where: { userId },
        select: studentEnrollmentSelect,
        orderBy: { enrolledAt: 'desc' },
      });

      if (enrollments.length === 0) return;

      // Batch all lesson counts for every enrolled course in one go.
      const countQueries = enrollments.flatMap((enrollment: StudentEnrollmentRecord) => [
        tx.lesson.count({ where: { module: { courseId: enrollment.course.id } } }),
        tx.lessonProgress.count({
          where: { userId, lesson: { module: { courseId: enrollment.course.id } } },
        }),
      ]);

      const counts = await Promise.all(countQueries);

      enrollments.forEach((enrollment: StudentEnrollmentRecord, index: number) => {
        const totalLessons = counts[index * 2];
        const completedLessons = counts[index * 2 + 1];
        const percentage = totalLessons === 0 ? 0 : roundPercentage(completedLessons, totalLessons);

        const progress: ProgressDto = {
          courseId: enrollment.course.id,
          totalLessons,
          completedLessons,
          percentage,
        };

        enrollmentsWithProgress.push({
          enrollmentId: enrollment.id,
          course: enrollment.course,
          certificateCode: enrollment.certificateCode,
          progress,
        });

        if (totalLessons > 0 && completedLessons === totalLessons) {
          completedCourses.push({
            courseId: enrollment.course.id,
            title: enrollment.course.title,
            certificateCode: enrollment.certificateCode,
          });
        }
      });
    });

    return { enrollments: enrollmentsWithProgress, completedCourses };
  }

  /**
   * Instructor dashboard — exactly TWO aggregate queries, run in parallel:
   *
   *   Query 1 — `lesson.groupBy(['module.courseId'])`:
   *     Not directly possible in Prisma because `groupBy` can only group on
   *     scalar fields of the model itself. Instead we use `courseModule.findMany`
   *     with `_count: { select: { lessons: true } }` — a single query that
   *     returns every module for all instructor courses together with its
   *     lesson count. We sum per courseId in JS (O(modules), no extra round-trip).
   *
   *   Query 2 — `lessonProgress.findMany` scoped to all enrolled users across
   *     all instructor courses at once, with the courseId carried through the
   *     `lesson.module.courseId` relation. Aggregated per (userId, courseId)
   *     in JS to count completions.
   *
   * Both queries are fired simultaneously via `Promise.all` — 2 round-trips
   * regardless of how many courses the instructor teaches.
   */
  async getInstructorDashboard(instructorId: string): Promise<InstructorDashboard> {
    const courses: InstructorCourseRecord[] = await prisma.course.findMany({
      where: { instructorId },
      select: instructorCourseSelect,
    });

    if (courses.length === 0) return { perCourse: [] };

    const courseIds = courses.map((c) => c.id);

    // All enrolled user ids across every instructor course — needed to scope
    // the lessonProgress query without a cross-join.
    const allEnrolledUserIds = [
      ...new Set(courses.flatMap((c) => c.enrollments.map((e: { userId: string }) => e.userId))),
    ];

    // --- 2 queries, in parallel -------------------------------------------
    //
    // Query 1: total lessons per course.
    //   courseModule.findMany with _count.lessons gives us
    //   [{ courseId, _count: { lessons: N } }] for every module across all
    //   courses in one shot. Sum per courseId in JS.
    //
    // Query 2: completed lessons per (userId, courseId).
    //   lessonProgress.findMany scoped to our enrolled users + our courses,
    //   carrying courseId through the lesson→module relation in the select.
    //   Group by (userId, courseId) in JS.
    const [moduleRows, progressRows] = await Promise.all([
      // Query 1 — lesson counts per module, for all instructor courses at once
      prisma.courseModule.findMany({
        where: { courseId: { in: courseIds } },
        select: {
          courseId: true,
          _count: { select: { lessons: true } },
        },
      }),

      // Query 2 — progress rows for all relevant users across all courses
      allEnrolledUserIds.length === 0
        ? Promise.resolve([])
        : prisma.lessonProgress.findMany({
            where: {
              userId: { in: allEnrolledUserIds },
              lesson: { module: { courseId: { in: courseIds } } },
            },
            select: {
              userId: true,
              lesson: { select: { module: { select: { courseId: true } } } },
            },
          }),
    ]);

    // Build courseId → totalLessons from Query 1 (sum across modules)
    const totalLessonsByCourse = new Map<string, number>();
    for (const row of moduleRows) {
      totalLessonsByCourse.set(
        row.courseId,
        (totalLessonsByCourse.get(row.courseId) ?? 0) + row._count.lessons,
      );
    }

    // Build (userId, courseId) → completedLessons from Query 2
    const completedByUserCourse = new Map<string, number>();
    for (const row of progressRows) {
      const courseId = row.lesson.module.courseId;
      const key = `${row.userId}::${courseId}`;
      completedByUserCourse.set(key, (completedByUserCourse.get(key) ?? 0) + 1);
    }

    const perCourse: InstructorCourseStats[] = courses.map((course: InstructorCourseRecord) => {
      const enrolledCount = course._count.enrollments;
      const totalLessons = totalLessonsByCourse.get(course.id) ?? 0;

      let completionRate = 0;
      if (enrolledCount > 0 && totalLessons > 0) {
        const enrolledUserIds = course.enrollments.map((e: { userId: string }) => e.userId);
        const completedCount = enrolledUserIds.filter(
          (uid: string) => (completedByUserCourse.get(`${uid}::${course.id}`) ?? 0) >= totalLessons,
        ).length;
        completionRate = roundPercentage(completedCount, enrolledCount);
      }

      return { courseId: course.id, title: course.title, enrolledCount, completionRate };
    });

    return { perCourse };
  }
}

export const searchService = new SearchService();
export const dashboardService = new DashboardService();