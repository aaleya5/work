import pino from 'pino';
import { env } from '../config/env';

/**
 * Shared structured logger. Service classes accept a child logger so log
 * lines can be tagged with a `module` field, e.g.:
 *
 * ```ts
 * const log = logger.child({ module: 'EnrollmentService' });
 * log.info({ userId, courseId }, 'Student enrolled in course');
 * ```
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
});

export type Logger = typeof logger;
