import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { UnauthorizedError, ForbiddenError } from '../errors/app-error';

/**
 * Registers `@fastify/jwt` and decorates the Fastify instance with two
 * reusable hooks:
 *
 * - `fastify.authenticate`  - `onRequest` hook that verifies the bearer
 *   token and populates `request.user`.
 * - `fastify.authorize(...roles)` - returns an `onRequest` hook that first
 *   authenticates, then checks `request.user.role` is one of `roles`.
 *
 * Usage in a route:
 *
 * ```ts
 * fastify.post('/courses', { onRequest: [fastify.authorize('INSTRUCTOR')] }, handler);
 * ```
 */
const authPlugin = fp(async (fastify: FastifyInstance) => {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  fastify.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      await request.jwtVerify();
    } catch {
      throw new UnauthorizedError('Missing or invalid authentication token');
    }
  });

  fastify.decorate(
    'authorize',
    (...roles: Role[]) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        await fastify.authenticate(request, reply);
        if (!roles.includes(request.user.role)) {
          throw new ForbiddenError(`Requires one of roles: ${roles.join(', ')}`);
        }
      },
  );
});

export default authPlugin;
