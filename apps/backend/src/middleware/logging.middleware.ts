import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import logger from '../lib/logger';

declare global {
  namespace Express {
    interface Request {
      id: string; // Request correlation ID
      userId?: string;
    }
  }
}

/**
 * Add request correlation ID and log incoming/outgoing requests.
 */
export function requestLoggingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Generate unique ID for this request
  req.id = randomUUID();

  const startTime = Date.now();
  const method = req.method;
  const path = req.path;

  // Log incoming request (debug level for most, info for writes)
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (isWrite) {
    logger.info(`${method} ${path}`, {
      requestId: req.id,
      method,
      path,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      userId: req.userId,
    });
  } else {
    logger.debug(`${method} ${path}`, {
      requestId: req.id,
      method,
      path,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      userId: req.userId,
    });
  }

  // Intercept response to log it
  const originalJson = res.json;
  res.json = function (data: any) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Log based on status code
    if (statusCode >= 500) {
      logger.error(`${method} ${path} - ${statusCode}`, {
        requestId: req.id,
        statusCode,
        duration,
        userId: req.userId,
        error: data?.error,
      });
    } else if (statusCode >= 400) {
      logger.warn(`${method} ${path} - ${statusCode}`, {
        requestId: req.id,
        statusCode,
        duration,
        userId: req.userId,
        error: data?.error,
      });
    } else {
      logger.debug(`${method} ${path} - ${statusCode}`, {
        requestId: req.id,
        statusCode,
        duration,
        userId: req.userId,
      });
    }

    return originalJson.call(this, data);
  };

  next();
}

/**
 * Extract userId from JWT token (if present) and attach to request.
 */
export function userIdMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      // For now, just pass through — actual JWT decode happens in auth.middleware
      // This is a placeholder for middleware order
    }
  } catch (err) {
    // Silently fail — auth middleware will handle auth errors properly
  }
  next();
}
