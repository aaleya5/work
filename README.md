# EduTrack API (Node.js / TypeScript / Fastify / Prisma)

A TypeScript port of the EduTrack education-platform backend, built on
**Fastify 4**, **Prisma 5** (PostgreSQL), and **Zod**. TypeScript strict mode
throughout, no `any` in application code, and every async route/service
method has an explicit `Promise<T>` return type.

## Stack

- Node.js 20 LTS, TypeScript 5 (strict)
- Fastify 4.x
- Prisma 5.x + PostgreSQL
- Zod (request validation, schema composition, `z.infer<>` DTOs)
- `@fastify/jwt` for authentication hooks
- `pino` (via Fastify) for structured logging
- Jest + `app.inject`, `@testcontainers/postgresql` for integration

## Project layout

```
prisma/
  schema.prisma        # Course, CourseModule, Lesson, Enrollment, LessonProgress,
                        # Quiz, Question, Option, QuizAttempt, User
  seed.ts               # sample course + quiz seed data

src/
  config/env.ts         # Zod-validated process.env
  errors/app-error.ts    # AppError + NotFound/Conflict/Unprocessable/Unauthorized/Forbidden
  types/api-response.ts  # ApiResponse<T>, PaginatedResponse<T>, ok()/fail()
  types/fastify.d.ts      # request.user, fastify.authenticate/authorize augmentation
  utils/logger.ts         # shared pino instance for service-level logging
  utils/pagination.ts      # generic paginate<T>() helper
  prisma.ts                 # PrismaClient singleton

  schemas/                  # All Zod schemas, DTOs inferred via z.infer<>
    common.schema.ts          # IdParamSchema, PaginationQuerySchema
    auth.schema.ts             # Register/Login/AuthResponse
    course.schema.ts            # CreateCourse/Module/Lesson, CourseWithModules, filters
    enrollment.schema.ts          # Enroll, Progress, CompletionStatus
    quiz.schema.ts                 # CreateQuiz/Question/Option, Answer, AttemptResult

  services/                  # All Prisma access lives here, wrapped in classes
    course.service.ts          # CourseService - CRUD, transactions, publish validation
    enrollment.service.ts        # EnrollmentService - enroll, progress, completion+certificate
    quiz.service.ts               # QuizService - student-safe selects, attempt scoring
    dashboard.service.ts           # SearchService + DashboardService
    auth.service.ts                 # AuthService - register/login (scrypt password hashing)

  plugins/
    auth.plugin.ts            # @fastify/jwt + fastify.authenticate / fastify.authorize(...roles)
    error-handler.plugin.ts    # AppError / ZodError / Prisma error -> ApiErrorResponse

  routes/                    # Thin Fastify handlers: Zod-validate -> call service -> ok()
    auth.routes.ts
    course.routes.ts
    enrollment.routes.ts
    quiz.routes.ts
    dashboard.routes.ts

  app.ts                     # buildApp(): FastifyInstance (used by tests via .inject)
  server.ts                   # process entrypoint

tests/
  unit/quiz.service.test.ts        # Prisma mocked via jest.mock('../../src/prisma')
  integration/enrollment.integration.test.ts  # Testcontainers Postgres + app.inject
```

## Setup

```bash
cp .env.example .env          # edit DATABASE_URL / JWT_SECRET
npm install
npx prisma generate           # generates the typed Prisma client (requires network access
                               # to download Prisma's query-engine binaries)
npx prisma migrate dev         # creates the database schema
npm run prisma:seed            # optional sample data (see prisma/seed.ts)
npm run typecheck               # tsc --noEmit
npm run dev                      # ts-node-dev
```

> **Note on `npx prisma generate`:** Prisma's CLI downloads platform-specific
> query-engine binaries from `binaries.prisma.sh` on first run. This requires
> outbound network access. `npm run typecheck` and `npm test` both depend on
> the generated `@prisma/client` types/runtime under `node_modules/.prisma`
> and will not pass until `prisma generate` has completed successfully.

### Tests

```bash
npm test                  # unit tests (mocked Prisma, no DB/network needed)
npm run test:integration  # Testcontainers - requires Docker
```

## Design notes

### Zod schema composition (Module 1)

`src/schemas/course.schema.ts` builds nested DTOs bottom-up:

```ts
CreateLessonSchema -> CreateModuleSchema (lessons: CreateLessonSchema.array())
                    -> CourseWithModulesSchema = CreateCourseSchema.extend({
                         modules: CreateModuleSchema.array().min(1),
                       })
```

`UpdateCourseSchema = CreateCourseSchema.partial()` reuses the same field
validators for PATCH. `src/schemas/quiz.schema.ts` follows the same pattern:
`CreateOptionSchema -> CreateQuestionSchema -> CreateQuizSchema`, with a
`.refine()` ensuring every question has at least one correct option.

### Prisma select/include + typed payloads (Modules 1, 3, 4)

Every service defines its read shape with `Prisma.validator<Prisma.XSelect>()({...})`
and derives an exact result type via `Prisma.XGetPayload<{ select: typeof xSelect }>`.
`courseSelect` nests `modules -> lessons` selects in one query.
`quizForStudentSelect` (Module 3) explicitly **omits `isCorrect`** from
`Option`, so the answer key never reaches the client before submission -
`submitAttempt` separately loads the quiz with
`include: { questions: { include: { options: true } } }` server-side only.

`CourseModule.moduleOrder` and `Lesson.lessonOrder` use
`@default(autoincrement())` (Postgres gives each such column its own
sequence), so ordering "just works" via `orderBy: { moduleOrder: 'asc' }`
without the application managing index gaps/shifts.

### Transactions

- `CourseService.create` uses `prisma.$transaction((tx) => tx.course.create({ data: { modules: { create: [...] } } }))`
  to create a course + modules + lessons atomically.
- `EnrollmentService.getProgress` uses `prisma.$transaction([lesson.count(...), lessonProgress.count(...)])`
  to compute `{ totalLessons, completedLessons, percentage }` consistently.
- `DashboardService.getStudentDashboard` batches all per-enrollment lesson
  counts into a single `$transaction` array.

### Errors (Module 5)

`AppError` (and `NotFoundError` / `ConflictError` / `UnprocessableEntityError`
/ `UnauthorizedError` / `ForbiddenError`) carry a `statusCode` and optional
`code`. `error-handler.plugin.ts` registers a single `setErrorHandler` that
maps `AppError`, `ZodError` (400 + per-field issues), and
`Prisma.PrismaClientKnownRequestError` (`P2002` -> 409, `P2025` -> 404) to
`ApiErrorResponse` bodies.

### Auth (JWT hooks)

`plugins/auth.plugin.ts` registers `@fastify/jwt` and decorates the Fastify
instance with:

- `fastify.authenticate` - `onRequest` hook, verifies the bearer token and
  populates `request.user: AuthenticatedUser`.
- `fastify.authorize(...roles)` - authenticate + role check, used as
  `{ onRequest: [fastify.authorize('INSTRUCTOR', 'ADMIN')] }`.

### Logging

`src/utils/logger.ts` exports a shared `pino` instance for service-level
structured logs (`logger.child({ module: 'EnrollmentService' })`,
`log.info({ userId, courseId }, 'Student enrolled in course')`). Fastify's
own request logger is configured separately in `app.ts` (level driven by
`LOG_LEVEL`).

## API summary

| Method & Path                          | Auth              | Description |
| --------------------------------------- | ----------------- | ----------- |
| `POST /api/auth/register`               | -                  | Create account, returns JWT |
| `POST /api/auth/login`                  | -                  | Returns JWT |
| `GET /api/courses`                      | -                  | Search/paginate published courses |
| `GET /api/courses/:id`                  | -                  | Course + modules + lessons |
| `GET /api/courses/slug/:slug`           | -                  | Same, by slug |
| `POST /api/courses`                     | INSTRUCTOR/ADMIN   | Create course + modules + lessons (transaction) |
| `PATCH /api/courses/:id`                | owner/ADMIN        | Partial update |
| `DELETE /api/courses/:id`               | owner/ADMIN        | Delete course |
| `POST /api/courses/:id/publish`         | owner/ADMIN        | Validate + publish |
| `POST /api/enrollments`                 | STUDENT            | Enroll in a published course |
| `POST /api/lessons/:lessonId/complete`  | STUDENT            | Mark lesson complete (idempotent) |
| `GET /api/courses/:id/progress`         | STUDENT            | `{ totalLessons, completedLessons, percentage }` |
| `GET /api/enrollments/:id/completion`   | STUDENT            | `{ lessonsComplete, quizzesPassed, eligible, certificateCode }` |
| `GET /api/quizzes/:id`                  | any authenticated  | Quiz without `isCorrect` |
| `POST /api/quizzes/:id/attempts`        | STUDENT            | Submit + score an attempt |
| `POST /api/courses/:courseId/quizzes`   | INSTRUCTOR/ADMIN   | Create quiz + questions + options |
| `GET /api/dashboard/student`            | STUDENT            | Enrollments w/ progress + completed courses |
| `GET /api/dashboard/instructor`         | INSTRUCTOR/ADMIN   | Per-course enrolled count + completion rate |
