import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateQuizSchema, SubmitAttemptSchema } from '../schemas/quiz.schema';
import { IdParamSchema } from '../schemas/common.schema';
import { quizService } from '../services/quiz.service';
import { ok } from '../types/api-response';

const CourseIdParamSchema = z.object({
  courseId: z.string().min(1, 'courseId is required'),
});

export default async function quizRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Returns the quiz with its questions/options but WITHOUT `isCorrect` -
   * see `quizForStudentSelect` in `QuizService`.
   */
  fastify.get(
    '/api/quizzes/:id',
    { onRequest: [fastify.authenticate] },
    async (request, reply): Promise<void> => {
      const { id } = IdParamSchema.parse(request.params);
      const quiz = await quizService.getQuizForStudent(id);
      reply.status(200).send(ok(quiz));
    },
  );

  fastify.post(
    '/api/quizzes/:id/attempts',
    { onRequest: [fastify.authorize('STUDENT')] },
    async (request, reply): Promise<void> => {
      const { id } = IdParamSchema.parse(request.params);
      const dto = SubmitAttemptSchema.parse(request.body);

      const result = await quizService.submitAttempt(request.user.id, id, dto.answers);
      reply.status(201).send(ok(result));
    },
  );

  fastify.post(
    '/api/courses/:courseId/quizzes',
    { onRequest: [fastify.authorize('INSTRUCTOR', 'ADMIN')] },
    async (request, reply): Promise<void> => {
      const { courseId } = CourseIdParamSchema.parse(request.params);
      const dto = CreateQuizSchema.parse(request.body);

      const quiz = await quizService.createQuiz(courseId, dto);
      reply.status(201).send(ok(quiz));
    },
  );
}
