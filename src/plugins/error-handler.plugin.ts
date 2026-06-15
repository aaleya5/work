import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { fail } from '../types/api-response';

/**
 * Centralised error handling. Every route handler is allowed to `throw` -
 * this hook converts the thrown value into a consistent
 * `ApiErrorResponse` JSON body with the right status code.
 *
 * Handles, in order:
 *  1. `AppError` (and subclasses) -> `error.statusCode`
 *  2. `ZodError`                  -> 400 with per-field issues
 *  3. Prisma known request errors -> mapped to sensible HTTP codes
 *  4. Anything else               -> 500, logged at error level
 */
const errorHandlerPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send(fail(error.message, error.code));
      return;
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      reply.status(400).send(fail('Validation failed', 'VALIDATION_ERROR', details));
      return;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        reply.status(409).send(fail('A record with this value already exists', 'DUPLICATE_RECORD'));
        return;
      }
      if (error.code === 'P2025') {
        reply.status(404).send(fail('Record not found', 'NOT_FOUND'));
        return;
      }

      request.log.error({ err: error, code: error.code }, 'Unhandled Prisma error');
      reply.status(500).send(fail('Database error', 'DATABASE_ERROR'));
      return;
    }

    const err = error instanceof Error ? error : new Error('Unknown error');
    request.log.error({ err }, 'Unhandled error');
    reply.status(500).send(fail('Internal server error', 'INTERNAL_ERROR'));
  });

  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send(fail(`Route ${request.method} ${request.url} not found`, 'ROUTE_NOT_FOUND'));
  });
});

export default errorHandlerPlugin;
