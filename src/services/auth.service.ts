import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Prisma } from '@prisma/client';
import prisma from '../prisma';
import { logger } from '../utils/logger';
import { ConflictError, UnauthorizedError } from '../errors/app-error';
import type { RegisterDto } from '../schemas/auth.schema';
import type { AuthenticatedUser } from '../types/fastify';

const log = logger.child({ module: 'AuthService' });
const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 64;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (salt === undefined || hash === undefined) {
    return false;
  }

  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const hashBuffer = Buffer.from(hash, 'hex');

  if (derived.length !== hashBuffer.length) {
    return false;
  }
  return timingSafeEqual(derived, hashBuffer);
}

export class AuthService {
  /** Creates a new user account with a scrypt-hashed password. */
  async register(dto: RegisterDto): Promise<AuthenticatedUser & { name: string }> {
    const passwordHash = await hashPassword(dto.password);

    try {
      const user = await prisma.user.create({
        data: {
          email: dto.email,
          password: passwordHash,
          name: dto.name,
          role: dto.role,
        },
        select: { id: true, email: true, name: true, role: true },
      });

      log.info({ userId: user.id, role: user.role }, 'User registered');
      return user;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
      }
      throw err;
    }
  }

  /** Verifies email/password and returns the authenticated principal, or throws 401. */
  async validateCredentials(email: string, password: string): Promise<AuthenticatedUser & { name: string }> {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, role: true, password: true },
    });

    if (!user) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      log.warn({ userId: user.id }, 'Login failed: invalid password');
      throw new UnauthorizedError('Invalid email or password');
    }

    log.info({ userId: user.id }, 'User logged in');
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }
}

export const authService = new AuthService();
