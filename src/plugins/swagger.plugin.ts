import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Converts a Zod schema into a plain JSON Schema object suitable for
 * `@fastify/swagger`. Centralised here so every route file imports the
 * same helper instead of re-deriving the `zod-to-json-schema` call
 * (and its options) on its own.
 */
export function zodSchema(schema: any): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: 'openApi3' }) as Record<string, unknown>;
}

/**
 * Registers `@fastify/swagger` + `@fastify/swagger-ui`.
 *
 * Route files attach `schema: { body: zodSchema(SomeSchema), response: {
 * ... } }` to their route options (see `course.routes.ts` for an example);
 * `@fastify/swagger` picks those up automatically when generating the
 * spec, so this plugin itself only needs to configure the document
 * metadata and where the UI is served.
 *
 * Must be registered before route plugins so the schemas they attach are
 * captured when the spec is generated.
 */
const swaggerPlugin = fp(async (fastify: FastifyInstance) => {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'EduTrack API',
        description: 'Course, enrollment, and quiz management API',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUI, {
    routePrefix: '/docs',
  });
});

export default swaggerPlugin;
