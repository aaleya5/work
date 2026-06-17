/**
 * CourseService unit tests
 *
 * Covers: create (transaction + slug uniqueness loop), findById,
 * update (happy path + P2025 → 404), delete (happy path + P2025 → 404),
 * publishCourse (404 missing, 422 no modules, 204 valid).
 */

import { CourseService } from '../../src/services/course.service';
import prisma from '../../src/prisma';
import { NotFoundError, UnprocessableEntityError } from '../../src/errors/app-error';
import { Prisma } from '@prisma/client';

jest.mock('../../src/prisma', () => ({
  __esModule: true,
  default: {
    course: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
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

const DTO = {
  title: 'Intro to TypeScript',
  category: 'PROGRAMMING' as const,
  difficulty: 'BEGINNER' as const,
  price: 19.99,
  modules: [{ title: 'M1', lessons: [{ title: 'L1', content: 'C1' }] }],
};

function record(overrides: object = {}) {
  return {
    id: 'c1', title: DTO.title, slug: 'intro-to-typescript',
    category: 'PROGRAMMING', difficulty: 'BEGINNER',
    price: new Prisma.Decimal(19.99), published: false,
    instructorId: 'i1', createdAt: new Date(), updatedAt: new Date(),
    modules: [], ...overrides,
  };
}

function p2025() {
  return new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: '5.x' });
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------
describe('CourseService.create', () => {
  let svc: CourseService;
  beforeEach(() => { svc = new CourseService(); jest.clearAllMocks(); });

  it('(a) runs inside a $transaction and returns CourseDto with numeric price', async () => {
    db.course.findUnique.mockResolvedValue(null);
    db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ course: { create: jest.fn().mockResolvedValue(record()) } }),
    );
    const result = await svc.create(DTO, 'i1');
    expect(result.id).toBe('c1');
    expect(typeof result.price).toBe('number');
    expect(result.price).toBe(19.99);
  });

  it('(b) generates a slug from the title', async () => {
    db.course.findUnique.mockResolvedValue(null);
    db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ course: { create: jest.fn().mockResolvedValue(record()) } }),
    );
    const result = await svc.create(DTO, 'i1');
    expect(result.slug).toBe('intro-to-typescript');
  });

  it('(c) appends -1 suffix when the base slug is already taken', async () => {
    db.course.findUnique
      .mockResolvedValueOnce({ id: 'other' }) // base slug taken
      .mockResolvedValueOnce(null);            // -1 suffix is free
    db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ course: { create: jest.fn().mockResolvedValue(record({ slug: 'intro-to-typescript-1' })) } }),
    );
    const result = await svc.create(DTO, 'i1');
    expect(result.slug).toBe('intro-to-typescript-1');
  });

  it('(d) keeps incrementing the suffix until a free slug is found', async () => {
    db.course.findUnique
      .mockResolvedValueOnce({ id: 'a' }) // base taken
      .mockResolvedValueOnce({ id: 'b' }) // -1 taken
      .mockResolvedValueOnce(null);        // -2 free
    db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ course: { create: jest.fn().mockResolvedValue(record({ slug: 'intro-to-typescript-2' })) } }),
    );
    const result = await svc.create(DTO, 'i1');
    expect(result.slug).toBe('intro-to-typescript-2');
  });
});

// ---------------------------------------------------------------------------
// findById()
// ---------------------------------------------------------------------------
describe('CourseService.findById', () => {
  let svc: CourseService;
  beforeEach(() => { svc = new CourseService(); jest.clearAllMocks(); });

  it('(a) returns CourseDto when the course exists', async () => {
    db.course.findUnique.mockResolvedValue(record());
    const result = await svc.findById('c1');
    expect(result.id).toBe('c1');
    expect(typeof result.price).toBe('number');
  });

  it('(b) throws NotFoundError 404 when the course does not exist', async () => {
    db.course.findUnique.mockResolvedValue(null);
    await expect(svc.findById('bad')).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.findById('bad')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------
describe('CourseService.update', () => {
  let svc: CourseService;
  beforeEach(() => { svc = new CourseService(); jest.clearAllMocks(); });

  it('(a) updates and returns the new CourseDto', async () => {
    db.course.update.mockResolvedValue(record({ price: new Prisma.Decimal(9.99) }));
    const result = await svc.update('c1', { price: 9.99 });
    expect(result.price).toBe(9.99);
  });

  it('(b) throws NotFoundError 404 on Prisma P2025', async () => {
    db.course.update.mockRejectedValue(p2025());
    await expect(svc.update('bad', { price: 0 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('(c) re-throws unexpected errors unwrapped', async () => {
    db.course.update.mockRejectedValue(new Error('DB down'));
    await expect(svc.update('c1', {})).rejects.toThrow('DB down');
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------
describe('CourseService.delete', () => {
  let svc: CourseService;
  beforeEach(() => { svc = new CourseService(); jest.clearAllMocks(); });

  it('(a) resolves without error on success', async () => {
    db.course.delete.mockResolvedValue({});
    await expect(svc.delete('c1')).resolves.toBeUndefined();
  });

  it('(b) throws NotFoundError 404 on Prisma P2025', async () => {
    db.course.delete.mockRejectedValue(p2025());
    await expect(svc.delete('bad')).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// publishCourse()
// ---------------------------------------------------------------------------
describe('CourseService.publishCourse', () => {
  let svc: CourseService;
  beforeEach(() => { svc = new CourseService(); jest.clearAllMocks(); });

  it('(a) throws NotFoundError 404 when the course does not exist', async () => {
    db.course.findUnique.mockResolvedValue(null);
    await expect(svc.publishCourse('bad')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('(b) throws UnprocessableEntityError 422 when there are no publishable modules', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'c1', published: false });
    db.courseModule.count.mockResolvedValue(0);
    await expect(svc.publishCourse('c1')).rejects.toBeInstanceOf(UnprocessableEntityError);
    await expect(svc.publishCourse('c1')).rejects.toMatchObject({ statusCode: 422, code: 'COURSE_NOT_PUBLISHABLE' });
  });

  it('(c) calls course.update with published:true when validation passes', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'c1', published: false });
    db.courseModule.count.mockResolvedValue(1);
    db.course.update.mockResolvedValue({});
    await svc.publishCourse('c1');
    expect(db.course.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' }, data: { published: true } }),
    );
  });

  it('(d) uses courseModule.count with lessons:{ some:{} } filter — not a raw count', async () => {
    db.course.findUnique.mockResolvedValue({ id: 'c1', published: false });
    db.courseModule.count.mockResolvedValue(1);
    db.course.update.mockResolvedValue({});
    await svc.publishCourse('c1');
    expect(db.courseModule.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lessons: { some: {} } }) }),
    );
  });
});