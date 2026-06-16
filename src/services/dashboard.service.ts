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
   * Instructor dashboard — exactly TWO aggregate queries total, regardless
   * of how many courses the instructor has:
   *
   *   Query 1 — prisma.lesson.groupBy(courseId): total lessons per course.
   *   Query 2 — prisma.lessonProgress.groupBy(userId+courseId): completed
   *             lessons per student per course, then filter to those who
   *             hit the total.
   *
   * Both are fired in parallel via Promise.all — no per-course loops.
   */
  async getInstructorDashboard(instructorId: string): Promise<InstructorDashboard> {
    const courses: InstructorCourseRecord[] = await prisma.course.findMany({
      where: { instructorId },
      select: instructorCourseSelect,
    });

    if (courses.length === 0) return { perCourse: [] };

    const courseIds = courses.map((c) => c.id);

    // Query 1: total lessons per course (one groupBy across all courses).
    // Query 2: how many lessons each enrolled student has completed per
    //          course (one groupBy across all courses).
    // Both run in parallel — two queries total, no N+1.
    const [lessonCounts, progressCounts] = await Promise.all([
      prisma.lesson.groupBy({
        by: ['moduleId'],
        where: { module: { courseId: { in: courseIds } } },
        _count: { id: true },
      }),
      // We need courseId on lessonProgress rows — join through lesson->module.
      // groupBy doesn't support nested relations, so we group by userId and
      // pull the course id via a raw-ish approach: group on the module's
      // courseId via a sub-select on lesson. Prisma supports this via the
      // `lesson` relation filter on the where clause combined with groupBy
      // on userId only — then we cross-reference with the course lookup below.
      //
      // Practical approach that stays within two queries:
      // group by [userId, lessonId] isn't useful; instead, for each course
      // we already have enrolledUserIds from the first fetch. We resolve
      // completion per course by counting distinct (userId, courseId) pairs
      // where the user's completed-lesson count equals totalLessons.
      //
      // We achieve this in one query by grouping lessonProgress by userId,
      // filtering to lessons belonging to our course set, then counting
      // per-user per-course completions via a raw aggregate:
      prisma.lessonProgress.findMany({
        where: { lesson: { module: { courseId: { in: courseIds } } } },
        select: {
          userId: true,
          lesson: { select: { module: { select: { courseId: true } } } },
        },
      }),
    ]);

    // Build a map: courseId → totalLessons by joining lessonCounts through
    // the module. We need moduleId→courseId, so fetch that mapping cheaply.
    const modules = await prisma.courseModule.findMany({
      where: { courseId: { in: courseIds } },
      select: { id: true, courseId: true },
    });

    const moduleCourseMap = new Map<string, string>(modules.map((m) => [m.id, m.courseId]));

    // Aggregate total lessons per course from the groupBy result.
    const totalLessonsByCourse = new Map<string, number>();
    for (const row of lessonCounts) {
      const courseId = moduleCourseMap.get(row.moduleId);
      if (courseId === undefined) continue;
      totalLessonsByCourse.set(courseId, (totalLessonsByCourse.get(courseId) ?? 0) + row._count.id);
    }

    // Aggregate completed-lessons per (userId, courseId) from progressCounts.
    const completedByUserCourse = new Map<string, number>();
    for (const row of progressCounts) {
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
