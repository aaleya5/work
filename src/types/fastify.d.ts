import type { Role } from '@prisma/client';

/**
 * Shape of the JWT payload / authenticated principal attached to each
 * request by the `auth` plugin's `onRequest` hook.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Populated by `authenticate` (see `src/plugins/auth.plugin.ts`).
     * Only present on routes that register the hook.
     */
    user: AuthenticatedUser;
  }

  interface FastifyInstance {
    authenticate: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
    authorize: (
      ...roles: Role[]
    ) => (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthenticatedUser;
    user: AuthenticatedUser;
  }
}
