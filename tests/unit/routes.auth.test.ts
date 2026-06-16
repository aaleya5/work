/**
 * Auth route + authorization tests
 *
 * Uses Fastify's `.inject()` to fire HTTP requests against a real app
 * instance (with Prisma mocked) — no real database, no network.
 *
 * Covers:
 *   - POST /api/auth/register: happy path, validation errors, duplicate email
 *   - POST /api/auth/login: happy path, wrong password
 *   - 401 when no token is provided to a protected route
 *   - 403 when the wrong role hits a role-restricted route
 *   - Course ownership: 403 when a different instructor tries to mutate
 */

import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock Prisma before importing the app so every service gets the mock.
// ---------------------------------------------------------------------------
jest.mock('../../src/prisma', () => ({
  __esModule: true,
  default: {
    user: { create: jest.fn(), findUnique: jest.fn() },
    course: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    courseModule: { count: jest.fn() },
    enrollment: { create: jest.fn(), findUnique: jest.fn() },
    lesson: { findUnique: jest.fn(), count: jest.fn() },
    lessonProgress: { upsert: jest.fn(), count: jest.fn() },
    quiz: { findUnique: jest.fn(), create: jest.fn(), count: jest.fn() },
    quizAttempt: { findMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import prisma from '../../src/prisma';
import { Prisma } from '@prisma/client';
import { buildApp } from '../../src/app';

type MockedPrisma = {
  user: { create: jest.Mock; findUnique: jest.Mock };
  course: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
  courseModule: { count: jest.Mock };
};

const db = prisma as unknown as MockedPrisma;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserRow(overrides: object = {}) {
  return { id: 'user-1', email: 'ada@example.com', name: 'Ada', role: 'INSTRUCTOR', ...overrides };
}

function makeCourseRow(overrides: object = {}) {
  return {
    id: 'course-1',
    title: 'Test Course',
    slug: 'test-course',
    category: 'PROGRAMMING',
    difficulty: 'BEGINNER',
    price: new Prisma.Decimal(0),
    published: false,
    instructorId: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    modules: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---- Register ----------------------------------------------------------

  describe('POST /api/auth/register', () => {
    it('returns 201 with a JWT token on success', async () => {
      db.user.create.mockResolvedValue(makeUserRow({ role: 'STUDENT' }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'ada@example.com', password: 'Password123', name: 'Ada', role: 'STUDENT' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(typeof body.data.token).toBe('string');
      expect(body.data.user.email).toBe('ada@example.com');
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'not-an-email', password: 'short' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 409 when the email is already taken', async () => {
      db.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique', { code: 'P2002', clientVersion: '5.x' }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'ada@example.com', password: 'Password123', name: 'Ada', role: 'STUDENT' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  // ---- Login -------------------------------------------------------------

  describe('POST /api/auth/login', () => {
    it('returns 400 when the body is empty', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 when the user does not exist', async () => {
      db.user.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nobody@example.com', password: 'Password123' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when the password is wrong', async () => {
      // Provide a stored hash that will never match 'WrongPassword'
      db.user.findUnique.mockResolvedValue({
        ...makeUserRow(),
        password: 'aabbccddeeff00112233445566778899:' + 'ff'.repeat(64),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'ada@example.com', password: 'WrongPassword' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ---- Authorization (401 / 403) -----------------------------------------

  describe('Authorization guards', () => {
    it('returns 401 when no token is provided to a protected route', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/dashboard/student' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when the token is malformed', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/student',
        headers: { authorization: 'Bearer not.a.valid.jwt' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when an INSTRUCTOR hits a STUDENT-only route', async () => {
      const token = app.jwt.sign({ id: 'user-1', email: 'ada@example.com', role: 'INSTRUCTOR' });
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/student',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 when a STUDENT hits an INSTRUCTOR-only route', async () => {
      const token = app.jwt.sign({ id: 'user-1', email: 'ada@example.com', role: 'STUDENT' });
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/instructor',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ---- Course ownership --------------------------------------------------

  describe('Course ownership guard', () => {
    it('returns 403 when a different instructor tries to update a course', async () => {
      // course belongs to 'owner-instructor', but the token is for 'other-instructor'
      db.course.findUnique.mockResolvedValue(makeCourseRow({ instructorId: 'owner-instructor' }));

      const token = app.jwt.sign({ id: 'other-instructor', email: 'other@example.com', role: 'INSTRUCTOR' });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/courses/course-1',
        headers: { authorization: `Bearer ${token}` },
        payload: { price: 0 },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 403 when a different instructor tries to publish a course', async () => {
      db.course.findUnique.mockResolvedValue(makeCourseRow({ instructorId: 'owner-instructor' }));

      const token = app.jwt.sign({ id: 'other-instructor', email: 'other@example.com', role: 'INSTRUCTOR' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/courses/course-1/publish',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 403 when a different instructor tries to delete a course', async () => {
      db.course.findUnique.mockResolvedValue(makeCourseRow({ instructorId: 'owner-instructor' }));

      const token = app.jwt.sign({ id: 'other-instructor', email: 'other@example.com', role: 'INSTRUCTOR' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/courses/course-1',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('allows ADMIN to mutate any course regardless of ownership', async () => {
      db.course.findUnique.mockResolvedValue(makeCourseRow({ instructorId: 'someone-else' }));
      db.courseModule.count.mockResolvedValue(1);
      db.course.update.mockResolvedValue({});

      const token = app.jwt.sign({ id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/courses/course-1/publish',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(204);
    });
  });

  // ---- Error shape -------------------------------------------------------

  describe('Error response shape', () => {
    it('returns { success: false, error: { message, code } } for AppError', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/dashboard/student' });
      const body = JSON.parse(res.body);

      expect(body.success).toBe(false);
      expect(body.error).toHaveProperty('message');
      expect(body.error).toHaveProperty('code');
    });

    it('returns 404 with ROUTE_NOT_FOUND for unknown paths', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    });
  });
});
