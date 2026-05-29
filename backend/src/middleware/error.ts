import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, code: err.code }, err.message);
    } else {
      logger.warn({ code: err.code, statusCode: err.statusCode }, err.message);
    }

    return c.json(
      { error: err.message, code: err.code, statusCode: err.statusCode },
      err.statusCode as ContentfulStatusCode,
    );
  }

  logger.error({ err }, 'Unhandled error');

  return c.json(
    { error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 },
    500 as ContentfulStatusCode,
  );
}
