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

## Node.js-specific design patterns

These come up in every backend interview, so they're answered here against
the actual code in this repo rather than in the abstract.

### Q1: `findUnique` vs. an `orThrow` variant, and null narrowing

Every service in this codebase uses plain `findUnique` (Prisma does ship an
`findUniqueOrThrow`, but it's not used here) and narrows the `null` case
explicitly, immediately, with an early return/throw:

```ts
const course = await prisma.course.findUnique({
  where: { id: courseId },
  select: { id: true, published: true },
});

if (!course) {
  throw new NotFoundError('Course', courseId);
}
// from this line on, TypeScript knows `course` is non-null -
// no `course!.published`, no optional chaining needed
if (!course.published) {
  throw new UnprocessableEntityError('Cannot enroll in an unpublished course', 'COURSE_NOT_PUBLISHED');
}
```

The reason for preferring this over `findUniqueOrThrow` is control over the
error shape. `findUniqueOrThrow` throws a `PrismaClientKnownRequestError`
with code `P2025` - a Prisma-specific error that the route layer would then
have to catch and translate into an HTTP-appropriate `AppError` anyway. Doing
the null check inline skips that translation step and throws the right
`AppError` subclass (`NotFoundError`, with the right entity name and id)
at the exact point the absence is discovered, which also means every
"not found" path in the app produces a consistent, typed 404 instead of
mixing Prisma's generic "record not found" with hand-thrown errors. The
trade-off is a few extra lines per method versus one-liner chaining, which
is a reasonable price for explicit control flow.

TypeScript's narrowing does the rest of the work for free: after the
`if (!course) throw ...`, every reference to `course` in the rest of the
function is typed as the non-null payload shape, so there's no need for
non-null assertions (`!`) or repeated optional chaining further down.

### Q2: should enroll → complete → certificate be one transaction?

Looking at how it's actually split in `EnrollmentService`:

- `markLessonComplete` does the enrollment check + the `upsert` of
  `lessonProgress`. This part **is** the only piece that strictly needs
  transactional atomicity, and it's a single `upsert` call, so it's already
  atomic by virtue of being one statement - no explicit `$transaction`
  needed.
- `getCompletionStatus` (checking "is the course now complete" and
  conditionally generating the certificate) is called **separately**,
  not nested inside `markLessonComplete`. This is a deliberate choice, not
  an oversight.

The reasoning: marking a single lesson complete is rarely the trigger for
"the course is now 100% done" - usually a student finishes a lesson, the
client calls `markLessonComplete`, gets back a `ProgressDto`, and only
calls `getCompletionStatus` later (e.g. when the student explicitly visits
a "view certificate" screen, or progress shows 100%). Forcing certificate
issuance to happen synchronously and transactionally inside step 2 would
mean every single lesson-completion request pays the cost of re-checking
quiz pass status and certificate state, even on lesson 1 of 40.

If they *were* combined into one flow, here's what failure at each step
would actually mean:

- **Step 2 fails (the `upsert`)**: nothing else has happened yet, so
  there's nothing to roll back. The lesson is simply not marked complete
  and the client can retry - `upsert` makes retries safe.
- **Step 3 fails (checking course completion)**: this is a read-only
  aggregation (counts + a `findMany` on `quizAttempt`). If it throws (e.g.
  a transient DB error), the lesson completion from step 2 has already been
  durably persisted - that's correct, not a bug. The student's progress
  shouldn't be lost just because the *follow-up* completion check failed.
  Retrying `getCompletionStatus` later re-derives the same answer from
  durable state; nothing needs to be undone.
- **Step 4 fails (certificate generation)**: this is the one place where
  wrapping in a transaction matters, and the code already does the right
  thing at a smaller scope - `certificateCode` is only written via a single
  `prisma.enrollment.update()` call guarded by `certificateCode === null`.
  If that update fails, the next call to `getCompletionStatus` just retries
  the same `randomUUID()` + update, because the guard means it's
  idempotent. There's no scenario where a certificate is half-issued.

So the actual design is: keep the *write* steps individually atomic
(`upsert`, a single guarded `update`) rather than wrapping unrelated
reads and writes into one large `$transaction`, which would hold a DB
connection/lock for the duration of an aggregation that doesn't need
write isolation. The cost of *not* using one giant transaction is that a
client could theoretically see `markLessonComplete` succeed and then a
separate `getCompletionStatus` call fail or run before the count reflects
the new write under a different isolation level - but since both run
against the same primary and Postgres' default read-committed isolation
makes the just-committed `upsert` visible to the very next query, that
race doesn't actually occur in practice here.

### Q3: wiring Zod into Fastify's request parsing

This project validates manually inside route handlers (`Schema.parse(request.body)`)
rather than using `fastify-type-provider-zod`. For example, in
`enrollment.routes.ts`:

```ts
fastify.post('/api/enrollments', { onRequest: [...] }, async (request, reply) => {
  const dto = EnrollSchema.parse(request.body); // throws ZodError on bad input
  const enrollment = await enrollmentService.enroll(request.user.id, dto.courseId);
  reply.status(201).send(ok(enrollment));
});
```

The thrown `ZodError` is caught centrally by `setErrorHandler` in
`error-handler.plugin.ts`, which maps it to a 400 with formatted field
errors - so handlers don't need their own try/catch.

The difference versus `fastify-type-provider-zod`:

- **`fastify-type-provider-zod`** lets you pass the Zod schema directly as
  Fastify's `schema.body`/`schema.querystring` option. Fastify then runs
  validation *before* the handler is invoked (as part of its own
  request-parsing lifecycle, using its compiled-validator hooks), and the
  type provider infers `request.body`'s TypeScript type directly from the
  schema - no manual `.parse()` call, and the OpenAPI/Swagger spec can be
  generated from the exact same schema object Fastify validates with.
  Validation failures are surfaced as Fastify's own `FST_ERR_VALIDATION`
  errors rather than a raw `ZodError`.
- **Manual `.parse()` in the handler** (what's actually used here) means
  validation runs as a normal synchronous statement inside the handler
  body, after `onRequest` hooks (like `fastify.authenticate`) have already
  run. This is why, in this codebase, auth checks happen before body
  validation - `fastify.authorize('STUDENT')` runs first via `onRequest`,
  then `EnrollSchema.parse()` runs once inside the handler. It also means
  the Zod schema and the OpenAPI schema are two separate things that have
  to be kept in sync by hand, which is exactly why the Swagger setup in
  this project explicitly converts the *same* Zod schema object via
  `zodToJsonSchema()` into the `schema.body` Fastify/Swagger expects
  (see `src/plugins/swagger.plugin.ts`) - so the docs and the validation
  aren't allowed to drift apart even though they run through different
  code paths.

The trade-off: the type-provider approach is less code and gets you
request-type inference for free, but ties validation timing to Fastify's
lifecycle and changes the shape of validation errors. The manual approach
used here keeps `AppError`/`ZodError` handling uniform in one place
(`setErrorHandler`) regardless of whether the error came from a route's
own `.parse()` call or from deep inside a service method, which mattered
more for this project than saving the handful of lines the type provider
would save.

### Q4: a type-safe `paginate<T>` across different Prisma models

Prisma generates a distinct delegate type for every model
(`Prisma.CourseDelegate`, `Prisma.UserDelegate`, ...), each with its own
`findMany`/`count` signatures, and those signatures are themselves generic -
the return type of `findMany` depends on whatever `select`/`include` the
caller passes. There's no single concrete `PrismaModelDelegate<T>` type
that could be accepted as a parameter and still preserve the exact shape
each call site needs.

`paginate<T>` in `src/utils/pagination.ts` sidesteps that by not taking a
Prisma delegate at all - it takes two **thunks** (zero-arg functions) that
the caller has already fully configured:

```ts
export async function paginate<T>(
  findPage: () => Promise<T[]>,
  countTotal: () => Promise<number>,
  page: number,
  size: number,
): Promise<PaginatedResponse<T>> {
  const [data, total] = await Promise.all([findPage(), countTotal()]);
  return { data, total, page, size, totalPages: Math.max(1, Math.ceil(total / size)) };
}
```

Called like:

```ts
const result = await paginate<CourseSearchRecord>(
  () => prisma.course.findMany({ where, select: courseSearchSelect, skip, take: size }),
  () => prisma.course.count({ where }),
  page,
  size,
);
```

This works for any model without `paginate` itself ever importing a
concrete Prisma type, because the genuinely model-specific part - building
the `where`/`select`/`skip`/`take` object with the right `Prisma.XWhereInput`
- happens at the call site, where the literal model type is already known
and Prisma's own generics already do the inference correctly. `paginate`
only ever sees the *result* of that call as a `Promise<T[]>`, so `T` is
whatever the caller's `select` produced (e.g. `CourseSearchRecord` above),
fully typed, without `paginate` needing to know `Course` exists.

The alternative - accepting `model: SomeDelegateLikeInterface<T>` and
calling `model.findMany(args)` inside `paginate` - was considered but
doesn't actually buy anything extra here: the `args` object's type
(`Prisma.CourseFindManyArgs` vs `Prisma.UserFindManyArgs`) still differs
per model, so a shared interface for it would either need to be `any`-typed
on the args or get a generic argument over the args shape too, which is
strictly more type machinery for the same result the thunk version gets
for free. Pushing query construction to the call site and keeping
`paginate` as a thin "run two things in parallel and shape the response"
helper is what keeps it fully generic without ever touching `any`.