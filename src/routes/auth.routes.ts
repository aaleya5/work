import type { FastifyInstance } from 'fastify';
import { LoginSchema, RegisterSchema, type AuthResponseDto } from '../schemas/auth.schema';
import { authService } from '../services/auth.service';
import { ok } from '../types/api-response';

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/auth/register', async (request, reply): Promise<void> => {
    const dto = RegisterSchema.parse(request.body);
    const user = await authService.register(dto);

    const token = await fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });

    const body: AuthResponseDto = {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };

    reply.status(201).send(ok(body));
  });

  fastify.post('/api/auth/login', async (request, reply): Promise<void> => {
    const dto = LoginSchema.parse(request.body);
    const user = await authService.validateCredentials(dto.email, dto.password);

    const token = await fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });

    const body: AuthResponseDto = {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };

    reply.status(200).send(ok(body));
  });
}
