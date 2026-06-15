import { PrismaClient } from '@prisma/client';
import { env } from './config/env';

/**
 * Single shared PrismaClient instance.
 *
 * Exported as a plain singleton (rather than wrapped in a class) so that
 * service unit tests can do `jest.mock('../prisma')` and provide a fully
 * mocked client without needing a real database connection.
 */
export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export default prisma;
