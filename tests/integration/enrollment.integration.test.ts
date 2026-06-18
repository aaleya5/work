import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';

/**
 * End-to-end style integration test:
 *  - Spins up a real Postgres instance via Testcontainers
 *  - Applies the Prisma schema with `prisma db push`
 *  - Seeds a course, enrolls a student, completes all lessons
 *  - Hits the running Fastify app (via `.inject`) to verify the
 *    completion-status endpoint reports `eligible: true`
 *
 * Requires Docker to be available in the environment running the tests.
 * Run with: `npm run test:integration`
 */
describe('Enrollment completion (integration)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let app: FastifyInstance;
  let prisma: import('../../src/prisma').SoftDeletePrismaClient;
  let studentToken: string;
  let enrollmentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.JWT_SECRET = 'integration-test-secret-key-1234567890';
    process.env.NODE_ENV = 'test';

    // Apply the schema to the freshly created database.
    execSync('npx prisma db push --skip-generate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'inherit',
    });

    // Imported after DATABASE_URL is set so the Prisma client connects to
    // the test container.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prismaModule = await import('../../src/prisma');
    prisma = prismaModule.default;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appModule = await import('../../src/app');
    app = await appModule.buildApp();
    await app.ready();

    // ---- Seed data ------------------------------------------------------
    const instructor = await prisma.user.create({
      data: {
        email: 'instructor@edutrack.test',
        password: 'hashed',
        name: 'Ada Instructor',
        role: 'INSTRUCTOR',
      },
    });

    const course = await prisma.course.create({
      data: {
        title: 'Intro to Testing',
        slug: 'intro-to-testing',
        category: 'PROGRAMMING',
        difficulty: 'BEGINNER',
        price: '0',
        published: true,
        instructorId: instructor.id,
        modules: {
          create: [
            {
              title: 'Module 1',
              lessons: {
                create: [
                  { title: 'Lesson 1', content: 'Content 1' },
                  { title: 'Lesson 2', content: 'Content 2' },
                ],
              },
            },
          ],
        },
      },
      include: { modules: { include: { lessons: true } } },
    });

    const student = await prisma.user.create({
      data: {
        email: 'student@edutrack.test',
        password: 'hashed',
        name: 'Grace Student',
        role: 'STUDENT',
      },
    });

    const enrollResponse = await app.inject({
      method: 'POST',
      url: '/api/enrollments',
      headers: { authorization: `Bearer ${signToken(app, student)}` },
      payload: { courseId: course.id },
    });

    studentToken = signToken(app, student);
    const enrollBody = JSON.parse(enrollResponse.body) as { data: { id: string } };
    enrollmentId = enrollBody.data.id;

    // Mark every lesson in the course complete for the student.
    for (const courseModule of course.modules) {
      for (const lesson of courseModule.lessons) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/lessons/${lesson.id}/complete`,
          headers: { authorization: `Bearer ${studentToken}` },
        });
        expect(response.statusCode).toBe(200);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await container?.stop();
  });

  it('reports eligible: true once all lessons are complete and no quizzes exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/enrollments/${enrollmentId}/completion`,
      headers: { authorization: `Bearer ${studentToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      data: { lessonsComplete: boolean; quizzesPassed: boolean; eligible: boolean; certificateCode: string | null };
    };

    expect(body.data.lessonsComplete).toBe(true);
    expect(body.data.quizzesPassed).toBe(true);
    expect(body.data.eligible).toBe(true);
    expect(body.data.certificateCode).not.toBeNull();
  });
});

function signToken(app: FastifyInstance, user: { id: string; email: string; role: Role }): string {
  return app.jwt.sign({ id: user.id, email: user.email, role: user.role });
}
