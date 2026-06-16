/**
 * CourseService unit tests
 *
 * Every Prisma call is mocked — no database needed.
 * Tests cover the service layer's business logic:
 *   - slug generation and uniqueness loop
 *   - transactional course creation
 *   - 404 on missing course
 *   - publish validation (needs at least one module with a lesson)
 *   - update and delete with P2025 → NotFoundError mapping
 */

import { CourseService } from '../../src/services/course.service';
import prisma from '../../src/prisma';
import { NotFoundError, UnprocessableEntityError } from '../../src/errors/app-error';
import { Prisma } from '@prisma/client';

jest.mock('../../src/prisma', () => ({
  __esModule: true,
  default: {
    course: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    courseModule: { count: jest.fn() },
    $transaction: jest.fn(),
  },
}));

type MockedPrisma = {
  course: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
  courseModule: { count: jest.Mock };
  $transaction: jest.Mock;
};

const db = prisma as unknown as MockedPrisma;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COURSE_DTO = {
  title: 'Intro to TypeScript',
  category: 'PROGRAMMING' as const,
  difficulty: 'BEGINNER' as const,
  price: 19.99,
  modules: [
    {
      title: 'Getting Started',
      lessons: [{ title: 'Why TS?', content: 'Overview' }],
    },
  ],
};

function makeCourseRecord(overrides: object = {}) {
  return {
    id: 'course-1',
    title: COURSE_DTO.title,
    slug: 'intro-to-typescript',
    category: 'PROGRAMMING',
    difficulty: 'BEGINNER',
    price: new Prisma.Decimal(19.99),
    published: false,
    instructorId: 'instructor-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    modules: [],
    ...overrides,
  };
}

describe('CourseService.create', () => {
  let service: CourseService;

  beforeEach(() => {
    service = new CourseService();
    jest.clearAllMocks();
  });

  it('creates the course inside a transaction and returns a CourseDto with numeric price', async () => {
    const record = makeCourseRecord();
    db.course.findUnique.mockResolvedValue(null); // slug is available
    db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        course: {
          create: jest.fn().mockResolvedValue(record),
        },
      }),
    );

    const result = await service.create(COURSE_DTO, 'instructor-1');

    expect(result.id).toBe('course-1');
    expect(typeof result.price).toBe('number');
    expect(result.price).toBe(19.99);
    expect(result.slug).toBe('intro-to-typescript');
  });

  it('appends a numeric suffix when the slug already exists', async () => {
    const record = makeCourseRecord({ slug: 'intro-to-typescript-1' });
    // First findUnique (slug check for base slug) returns a hit; second returns null
    db.course.findUnique
      .mockResolvedValueOnce({ id: 'other-course' }) // 'intro-to-typescript' taken
      .mockResolvedValueOnce(null);                   // 'intro-to-typescript-1' free

    db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ course: { create: jest.fn().mockResolvedValue(record) } }),
    );

    const result = await service.create(COURSE_DTO, 'instructor-1');
    expect(result.slug).toBe('intro-to-typescript-1');
  });
});

describe('CourseService.findById', () => {
  let service: CourseService;

  beforeEach(() => {
    service = new CourseService();
    jest.clearAllMocks();
  });

  it('returns a CourseDto when the course exists', async () => {
    db.course.findUnique.mockResolvedValue(makeCourseRecord());
    const result = await service.findById('course-1');
    expect(result.id).toBe('course-1');
    expect(typeof result.price).toBe('number');
  });

  it('throws NotFoundError (404) when the course does not exist', async () => {
    db.course.findUnique.mockResolvedValue(null);
    await expect(service.findById('bad-id')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.findById('bad-id')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('CourseService.update', () => {
  let service: CourseService;

  beforeEach(() => {
    service = new CourseService();
    jest.clearAllMocks();
  });

  it('updates the course and returns the new CourseDto', async () => {
    const updated = makeCourseRecord({ price: new Prisma.Decimal(9.99) });
    db.course.update.mockResolvedValue(updated);

    const result = await service.update('course-1', { price: 9.99 });
    expect(result.price).toBe(9.99);
  });

  it('throws NotFoundError (404) when Prisma returns P2025', async () => {
    db.course.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: '5.x' }),
    );
    await expect(service.update('bad-id', { price: 0 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('CourseService.delete', () => {
  let service: CourseService;

  beforeEach(() => {
    service = new CourseService();
    jest.clearAllMocks();
  });

  it('deletes the course without error', async () => {
    db.course.delete.mockResolvedValue({});
    await expect(service.delete('course-1')).resolves.toBeUndefined();
  });

  it('throws NotFoundError (404) when Prisma returns P2025', async () => {
    db.course.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: '5.x' }),
    );
    await expect(service.delete('bad-id')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('CourseService.publishCourse', () => {
  let service: CourseService;

  beforeEach(() => {
    service = new CourseService();
    jest.clearAllMocks();
  });

  it('throws NotFoundError (404) when the course does not exist', async () => {
    db.course.findUnique.mockResolvedValue(null);
    await expect(service.publishCourse('bad-id')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws UnprocessableEntityError (422) when the course has no modules with lessons', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'course-1', published: false });
    db.courseModule.count.mockResolvedValue(0); // no publishable modules

    await expect(service.publishCourse('course-1')).rejects.toBeInstanceOf(UnprocessableEntityError);
    await expect(service.publishCourse('course-1')).rejects.toMatchObject({ statusCode: 422 });
  });

  it('calls course.update to flip published=true when validation passes', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'course-1', published: false });
    db.courseModule.count.mockResolvedValue(1); // one module with at least one lesson
    db.course.update.mockResolvedValue({});

    await service.publishCourse('course-1');

    expect(db.course.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'course-1' }, data: { published: true } }),
    );
  });
});
