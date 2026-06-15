import { Prisma } from '@prisma/client';
import prisma from '../prisma';
import { logger } from '../utils/logger';
import { paginate } from '../utils/pagination';
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
  /**
   * Builds a dynamic `Prisma.CourseWhereInput` from optional filters and
   * returns a paginated, search-ranked result set. Always restricted to
   * `published: true` courses.
   */
  async searchCourses(filters: CourseFiltersDto): Promise<PaginatedResponse<CourseSearchResultDto>> {
    let where: Prisma.CourseWhereInput = { published: true };

    if (filters.category !== undefined) {
      where = { ...where, category: filters.category };
    }
    if (filters.difficulty !== undefined) {
      where = { ...where, difficulty: filters.difficulty };
    }
    if (filters.search !== undefined) {
      where = { ...where, title: { contains: filters.search, mode: 'insensitive' } };
    }
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      const priceFilter: Prisma.DecimalFilter<'Course'> = {};
      if (filters.minPrice !== undefined) {
        priceFilter.gte = filters.minPrice;
      }
      if (filters.maxPrice !== undefined) {
        priceFilter.lte = filters.maxPrice;
      }
      where = { ...where, price: priceFilter };
    }

    const page = filters.page;
    const size = filters.size;
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
   * Returns all of a student's enrollments (with live progress) plus the
   * subset of courses they've fully completed.
   *
   * All counting queries are issued together via `prisma.$transaction` so
   * the whole dashboard reflects a single consistent snapshot.
   */
  async getStudentDashboard(userId: string): Promise<StudentDashboard> {
    const enrollments: StudentEnrollmentRecord[] = await prisma.enrollment.findMany({
      where: { userId },
      select: studentEnrollmentSelect,
      orderBy: { enrolledAt: 'desc' },
    });

    if (enrollments.length === 0) {
      return { enrollments: [], completedCourses: [] };
    }

    const countQueries = enrollments.flatMap((enrollment: StudentEnrollmentRecord) => [
      prisma.lesson.count({ where: { module: { courseId: enrollment.course.id } } }),
      prisma.lessonProgress.count({
        where: { userId, lesson: { module: { courseId: enrollment.course.id } } },
      }),
    ]);

    const counts = await prisma.$transaction(countQueries);

    const enrollmentsWithProgress: EnrollmentWithProgress[] = [];
    const completedCourses: CompletedCourse[] = [];

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

    return { enrollments: enrollmentsWithProgress, completedCourses };
  }

  /**
   * Per-course stats for an instructor: enrolled count (via `_count`) and
   * completion rate, computed from a `lessonProgress.groupBy` aggregate
   * with a `having` clause that filters to students who finished every
   * lesson in the course.
   */
  async getInstructorDashboard(instructorId: string): Promise<InstructorDashboard> {
    const courses: InstructorCourseRecord[] = await prisma.course.findMany({
      where: { instructorId },
      select: instructorCourseSelect,
    });

    const perCourse: InstructorCourseStats[] = [];

    for (const course of courses) {
      const enrolledCount = course._count.enrollments;
      let completionRate = 0;

      if (enrolledCount > 0) {
        const totalLessons = await prisma.lesson.count({ where: { module: { courseId: course.id } } });

        if (totalLessons > 0) {
          const enrolledUserIds = course.enrollments.map((enrollment: { userId: string }) => enrollment.userId);

          const studentsWithAllLessonsDone = await prisma.lessonProgress.groupBy({
            by: ['userId'],
            where: {
              userId: { in: enrolledUserIds },
              lesson: { module: { courseId: course.id } },
            },
            _count: { lessonId: true },
            having: {
              lessonId: { _count: { equals: totalLessons } },
            },
          });

          completionRate = roundPercentage(studentsWithAllLessonsDone.length, enrolledCount);
        }
      }

      perCourse.push({ courseId: course.id, title: course.title, enrolledCount, completionRate });
    }

    return { perCourse };
  }
}

function roundPercentage(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10000) / 100;
}

export const searchService = new SearchService();
export const dashboardService = new DashboardService();
