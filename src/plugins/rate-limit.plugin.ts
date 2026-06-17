import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { fail } from '../types/api-response';

/**
 * Registers `@fastify/rate-limit` globally with a Redis backend so limits
 * are shared across instances rather than kept in per-process memory.
 *
 * This plugin only sets up the *global default* (a generous ceiling so a
 * single client can't hammer the whole API). The two business-specific
 * limits called out in the brief - enrollment (10/min) and quiz
 * submission (5/min), both keyed per user rather than per IP - are applied
 * at the route level via the `config.rateLimit` option (see
 * `enrollment.routes.ts` and `quiz.routes.ts`), since `@fastify/rate-limit`
 * lets each route override the global config.
 *
 * If `REDIS_URL` isn't set (e.g. running tests without a Redis instance),
 * the plugin falls back to the in-memory store rather than failing to
 * boot - fine for local/dev/test, not recommended for a multi-instance
 * production deployment.
 */
const rateLimitPlugin = fp(async (fastify: FastifyInstance) => {
  const redis = env.REDIS_URL ? new Redis(env.REDIS_URL) : undefined;

  await fastify.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    redis,
    // Per-user limiting where we have an authenticated user (enrollment /
    // quiz routes run after `fastify.authorize`, so `request.user` is
    // already populated by the time this hook runs); falls back to IP for
    // unauthenticated routes.
    keyGenerator: (request: FastifyRequest): string => request.user?.id ?? request.ip,
    errorResponseBuilder: (_request: FastifyRequest, context) => {
      return fail(
        `Rate limit exceeded, retry in ${context.after}`,
        'RATE_LIMIT_EXCEEDED',
      );
    },
  });
});

export default rateLimitPlugin;
