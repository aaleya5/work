import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const instructor = await prisma.user.upsert({
    where: { email: 'instructor@edutrack.dev' },
    update: {},
    create: {
      email: 'instructor@edutrack.dev',
      // NOTE: this is a placeholder, not a real scrypt hash. Use the
      // /api/auth/register endpoint to create accounts with valid
      // password hashes.
      password: 'seed-placeholder',
      name: 'Ada Instructor',
      role: 'INSTRUCTOR',
    },
  });

  const student = await prisma.user.upsert({
    where: { email: 'student@edutrack.dev' },
    update: {},
    create: {
      email: 'student@edutrack.dev',
      password: 'seed-placeholder',
      name: 'Grace Student',
      role: 'STUDENT',
    },
  });

  const course = await prisma.course.upsert({
    where: { slug: 'intro-to-typescript' },
    update: {},
    create: {
      title: 'Intro to TypeScript',
      slug: 'intro-to-typescript',
      category: 'PROGRAMMING',
      difficulty: 'BEGINNER',
      price: '49.99',
      published: true,
      instructorId: instructor.id,
      modules: {
        create: [
          {
            title: 'Getting Started',
            lessons: {
              create: [
                { title: 'Why TypeScript?', content: 'An overview of TypeScript and its benefits.' },
                { title: 'Setting Up Your Environment', content: 'Installing Node, TypeScript and an editor.' },
              ],
            },
          },
          {
            title: 'Core Types',
            lessons: {
              create: [
                { title: 'Primitives & Arrays', content: 'string, number, boolean, arrays and tuples.' },
                { title: 'Interfaces & Type Aliases', content: 'Modelling shapes of data.' },
              ],
            },
          },
        ],
      },
      quizzes: {
        create: [
          {
            title: 'TypeScript Basics Quiz',
            maxAttempts: 3,
            passScore: 70,
            questions: {
              create: [
                {
                  text: 'Which keyword declares a type alias?',
                  options: {
                    create: [
                      { text: 'type', isCorrect: true },
                      { text: 'interface', isCorrect: false },
                      { text: 'alias', isCorrect: false },
                    ],
                  },
                },
                {
                  text: 'What does `strict: true` enable in tsconfig?',
                  options: {
                    create: [
                      { text: 'A bundle of strict type-checking flags', isCorrect: true },
                      { text: 'Strict CSS linting', isCorrect: false },
                      { text: 'Faster builds only', isCorrect: false },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  });

  await prisma.enrollment.upsert({
    where: { userId_courseId: { userId: student.id, courseId: course.id } },
    update: {},
    create: { userId: student.id, courseId: course.id },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded course "${course.title}" (${course.slug})`);
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
