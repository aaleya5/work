import { Prisma } from '@prisma/client';
import prisma from '../prisma';
import { logger } from '../utils/logger';
import { NotFoundError, UnprocessableEntityError } from '../errors/app-error';
import type { CourseWithModulesDto, UpdateCourseDto } from '../schemas/course.schema';

const log = logger.child({ module: 'CourseService' });

// ---------------------------------------------------------------------------
// Typed select + derived DTO
// ---------------------------------------------------------------------------

/**
 * `Prisma.validator` gives us compile-time checking of this object against
 * `Prisma.CourseSelect` while preserving the *literal* shape so that
 * `Prisma.CourseGetPayload<{ select: typeof courseSelect }>` can infer an
 * exact result type below.
 */
export const courseSelect = Prisma.validator<Prisma.CourseSelect>()({
  id: true,
  title: true,
  slug: true,
  category: true,
  difficulty: true,
  price: true,
  published: true,
  instructorId: true,
  createdAt: true,
  updatedAt: true,
  modules: {
    select: {
      id: true,
      title: true,
      moduleOrder: true,
      lessons: {
        select: {
          id: true,
          title: true,
          videoUrl: true,
          lessonOrder: true,
        },
        orderBy: { lessonOrder: 'asc' },
      },
    },
    orderBy: { moduleOrder: 'asc' },
  },
});

/** Raw row shape returned by Prisma for `courseSelect`. */
export type CourseRecord = Prisma.CourseGetPayload<{ select: typeof courseSelect }>;

/**
 * API-facing DTO. Identical to `CourseRecord` except `price` is a plain
 * `number` (JSON has no `Decimal` type, and clients shouldn't have to know
 * about `Prisma.Decimal`).
 */
export type CourseDto = Omit<CourseRecord, 'price'> & { price: number };

function toCourseDto(record: CourseRecord): CourseDto {
  return { ...record, price: record.price.toNumber() };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CourseService {
  /**
   * Creates a course together with its full module/lesson tree atomically.
   * If any nested `create` fails, the whole course creation is rolled back.
   */
  async create(dto: CourseWithModulesDto, instructorId: string): Promise<CourseDto> {
    const slug = await this.generateUniqueSlug(dto.title);

    const record = await prisma.$transaction((tx) =>
      tx.course.create({
        data: {
          title: dto.title,
          slug,
          category: dto.category,
          difficulty: dto.difficulty,
          price: new Prisma.Decimal(dto.price),
          instructorId,
          modules: {
            create: dto.modules.map((module) => ({
              title: module.title,
              lessons: {
                create: module.lessons.map((lesson) => ({
                  title: lesson.title,
                  content: lesson.content,
                  videoUrl: lesson.videoUrl,
                })),
              },
            })),
          },
        },
        select: courseSelect,
      }),
    );

    log.info({ courseId: record.id, instructorId, moduleCount: dto.modules.length }, 'Course created');
    return toCourseDto(record);
  }

  async findById(id: string): Promise<CourseDto> {
    const record = await prisma.course.findUnique({ where: { id }, select: courseSelect });
    if (!record) {
      throw new NotFoundError('Course', id);
    }
    return toCourseDto(record);
  }

  async findBySlug(slug: string): Promise<CourseDto> {
    const record = await prisma.course.findUnique({ where: { slug }, select: courseSelect });
    if (!record) {
      throw new NotFoundError('Course', slug);
    }
    return toCourseDto(record);
  }

  async update(id: string, dto: UpdateCourseDto): Promise<CourseDto> {
    const data: Prisma.CourseUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.difficulty !== undefined) data.difficulty = dto.difficulty;
    if (dto.price !== undefined) data.price = new Prisma.Decimal(dto.price);

    try {
      const record = await prisma.course.update({ where: { id }, data, select: courseSelect });
      log.info({ courseId: id, fields: Object.keys(data) }, 'Course updated');
      return toCourseDto(record);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundError('Course', id);
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await prisma.course.delete({ where: { id } });
      log.info({ courseId: id }, 'Course deleted');
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundError('Course', id);
      }
      throw err;
    }
  }

  /**
   * Validates that a course is ready to go live and flips `published`.
   *
   * A course is publishable once it has at least one module that itself
   * has at least one lesson, checked with a single Prisma `count` query
   * using the `lessons: { some: {} }` relation filter.
   */
  async publishCourse(id: string): Promise<void> {
    const course = await prisma.course.findUnique({ where: { id }, select: { id: true, published: true } });
    if (!course) {
      throw new NotFoundError('Course', id);
    }

    const publishableModuleCount = await prisma.courseModule.count({
      where: {
        courseId: id,
        lessons: { some: {} },
      },
    });

    if (publishableModuleCount < 1) {
      throw new UnprocessableEntityError(
        'Course must have at least one module containing at least one lesson before it can be published',
        'COURSE_NOT_PUBLISHABLE',
      );
    }

    await prisma.course.update({ where: { id }, data: { published: true } });
    log.info({ courseId: id }, 'Course published');
  }

  private async generateUniqueSlug(title: string): Promise<string> {
    const base = slugify(title);
    let slug = base.length > 0 ? base : 'course';
    let suffix = 1;

    for (;;) {
      const existing = await prisma.course.findUnique({ where: { slug }, select: { id: true } });
      if (!existing) {
        return slug;
      }
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
  }
}

export const courseService = new CourseService();
