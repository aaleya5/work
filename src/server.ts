import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import prisma from './prisma';

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'EduTrack API listening');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error');
  process.exitCode = 1;
});
