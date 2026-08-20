import winston from 'winston';
import path from 'path';

const isDev = process.env.NODE_ENV !== 'production';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    isDev
      ? winston.format.simple()
      : winston.format.json()
  ),
  defaultMeta: { service: 'rabitech-backend' },
  transports: [
    new winston.transports.Console({
      format: isDev
        ? winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, ...meta }) => {
              const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
              return `${timestamp} [${level}] ${message} ${metaStr}`;
            })
          )
        : winston.format.json(),
    }),
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'error.log'),
      level: 'error',
      format: winston.format.json(),
    }),
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'combined.log'),
      format: winston.format.json(),
    }),
  ],
});

export default logger;
