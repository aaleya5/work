import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env';
import errorHandlerPlugin from './plugins/error-handler.plugin';
import authPlugin from './plugins/auth.plugin';
import authRoutes from './routes/auth.routes';
import courseRoutes from './routes/course.routes';
import enrollmentRoutes from './routes/enrollment.routes';
import quizRoutes from './routes/quiz.routes';
import dashboardRoutes from './routes/dashboard.routes';

/**
 * Builds (but does not start) a fully configured Fastify instance.
 * Kept separate from `server.ts` so integration tests can build an app and
 * use `app.inject(...)` without binding a real port.
 *
 * Fastify's request logger is configured directly (rather than passing the
 * standalone `pino` instance from `utils/logger`) so its type lines up with
 * `FastifyBaseLogger`. Service classes still use the shared `logger` for
 * structured, non-request-scoped logging (see `utils/logger.ts`).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
  });

  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  await app.register(authRoutes);
  await app.register(courseRoutes);
  await app.register(enrollmentRoutes);
  await app.register(quizRoutes);
  await app.register(dashboardRoutes);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
