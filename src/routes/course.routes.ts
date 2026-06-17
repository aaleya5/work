import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import {
  CourseFiltersSchema,
  CourseWithModulesSchema,
  UpdateCourseSchema,
} from '../schemas/course.schema';
import { IdParamSchema } from '../schemas/common.schema';
import { courseService } from '../services/course.service';
import { searchService } from '../services/dashboard.service';
import { ForbiddenError } from '../errors/app-error';
import { ok } from '../types/api-response';
import { zodSchema } from '../plugins/swagger.plugin';

export default async function courseRoutes(fastify: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------
  // Public: search + read
  // ---------------------------------------------------------------------

  fastify.get(
    '/api/courses',
    { schema: { tags: ['courses'], querystring: zodSchema(CourseFiltersSchema) } },
    async (request, reply): Promise<void> => {
      const filters = CourseFiltersSchema.parse(request.query);
      const result = await searchService.searchCourses(filters);
      reply.status(200).send(ok(result));
    },
  );

  fastify.get(
    '/api/courses/slug/:slug',
    { schema: { tags: ['courses'] } },
    async (request, reply): Promise<void> => {
      const { slug } = request.params as { slug: string };
      const course = await courseService.findBySlug(slug);
      reply.status(200).send(ok(course));
    },
  );

  fastify.get(
    '/api/courses/:id',
    { schema: { tags: ['courses'] } },
    async (request, reply): Promise<void> => {
      const { id } = IdParamSchema.parse(request.params);
      const course = await courseService.findById(id);
      reply.status(200).send(ok(course));
    },
  );

  // ---------------------------------------------------------------------
  // Instructor-only: create / update / delete / publish
  // ---------------------------------------------------------------------

  fastify.post(
    '/api/courses',
    {
      onRequest: [fastify.authorize('INSTRUCTOR', 'ADMIN')],
      schema: {
        tags: ['courses'],
        security: [{ bearerAuth: [] }],
        body: zodSchema(CourseWithModulesSchema),
      },
    },
    async (request, reply): Promise<void> => {
      const dto = CourseWithModulesSchema.parse(request.body);
      const course = await courseService.create(dto, request.user.id);
      reply.status(201).send(ok(course));
    },
  );

  fastify.patch(
    '/api/courses/:id',
    {
      onRequest: [fastify.authorize('INSTRUCTOR', 'ADMIN')],
      schema: {
        tags: ['courses'],
        security: [{ bearerAuth: [] }],
        body: zodSchema(UpdateCourseSchema),
      },
    },
    async (request, reply): Promise<void> => {
      const { id } = IdParamSchema.parse(request.params);
      const dto = UpdateCourseSchema.parse(request.body);

      await assertCourseOwnership(fastify, id, request.user.id, request.user.role);
      const course = await courseService.update(id, dto);
      reply.status(200).send(ok(course));
    },
  );

  fastify.delete(
    '/api/courses/:id',
    {
      onRequest: [fastify.authorize('INSTRUCTOR', 'ADMIN')],
      schema: { tags: ['courses'], security: [{ bearerAuth: [] }] },
    },
    async (request, reply): Promise<void> => {
      const { id } = IdParamSchema.parse(request.params);

      await assertCourseOwnership(fastify, id, request.user.id, request.user.role);
      await courseService.delete(id);
      reply.status(204).send();
    },
  );

  fastify.post(
    '/api/courses/:id/publish',
    {
      onRequest: [fastify.authorize('INSTRUCTOR', 'ADMIN')],
      schema: { tags: ['courses'], security: [{ bearerAuth: [] }] },
    },
    async (request, reply): Promise<void> => {
      const { id } = IdParamSchema.parse(request.params);

      await assertCourseOwnership(fastify, id, request.user.id, request.user.role);
      await courseService.publishCourse(id);
      reply.status(204).send();
    },
  );
}

/** Ensures the requester owns the course (or is an ADMIN) before mutating it. */
async function assertCourseOwnership(
  fastify: FastifyInstance,
  courseId: string,
  userId: string,
  role: Role,
): Promise<void> {
  if (role === 'ADMIN') {
    return;
  }

  const course = await courseService.findById(courseId);
  if (course.instructorId !== userId) {
    fastify.log.warn({ courseId, userId }, 'Course ownership check failed');
    throw new ForbiddenError('You do not have permission to modify this course');
  }
}
