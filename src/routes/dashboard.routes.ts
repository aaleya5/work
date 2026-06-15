import type { FastifyInstance } from 'fastify';
import { dashboardService } from '../services/dashboard.service';
import { ok } from '../types/api-response';

export default async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/dashboard/student',
    { onRequest: [fastify.authorize('STUDENT')] },
    async (request, reply): Promise<void> => {
      const dashboard = await dashboardService.getStudentDashboard(request.user.id);
      reply.status(200).send(ok(dashboard));
    },
  );

  fastify.get(
    '/api/dashboard/instructor',
    { onRequest: [fastify.authorize('INSTRUCTOR', 'ADMIN')] },
    async (request, reply): Promise<void> => {
      const dashboard = await dashboardService.getInstructorDashboard(request.user.id);
      reply.status(200).send(ok(dashboard));
    },
  );
}
