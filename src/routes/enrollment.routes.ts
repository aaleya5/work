import type { FastifyInstance } from 'fastify';
import { EnrollSchema, MarkLessonCompleteParamsSchema } from '../schemas/enrollment.schema';
import { IdParamSchema } from '../schemas/common.schema';
import { enrollmentService } from '../services/enrollment.service';
import { ok } from '../types/api-response';

export default async function enrollmentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/enrollments',
    { onRequest: [fastify.authorize('STUDENT')] },
    async (request, reply): Promise<void> => {
      const dto = EnrollSchema.parse(request.body);
      const enrollment = await enrollmentService.enroll(request.user.id, dto.courseId);
      reply.status(201).send(ok(enrollment));
    },
  );

  fastify.post(
    '/api/lessons/:lessonId/complete',
    { onRequest: [fastify.authorize('STUDENT')] },
    async (request, reply): Promise<void> => {
      const { lessonId } = MarkLessonCompleteParamsSchema.parse(request.params);
      const progress = await enrollmentService.markLessonComplete(request.user.id, lessonId);
      reply.status(200).send(ok(progress));
    },
  );

  fastify.get(
    '/api/courses/:id/progress',
    { onRequest: [fastify.authorize('STUDENT')] },
    async (request, reply): Promise<void> => {
      const { id } = IdParamSchema.parse(request.params);
      const progress = await enrollmentService.getProgress(request.user.id, id);
      reply.status(200).send(ok(progress));
    },
  );

  fastify.get(
    '/api/enrollments/:id/completion',
    { onRequest: [fastify.authorize('STUDENT')] },
    async (request, reply): Promise<void> => {
      const { id } = IdParamSchema.parse(request.params);
      const status = await enrollmentService.getCompletionStatus(request.user.id, id);
      reply.status(200).send(ok(status));
    },
  );
}
