import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config, isProd } from '../config.js';
import { prisma } from '../db.js';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';
import { coreRouter } from '../routes/core.js';
import { financeRouter } from '../routes/finance.js';
import { propertyRouter } from '../routes/property.js';
import { errorHandler } from './errors.js';
import { csrfProtection, loadSession } from './middleware.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
      },
    },
    // Only promise HTTPS when actually deployed behind it.
    strictTransportSecurity: isProd,
  }));

  /** Liveness + database connectivity. Used by load balancers and uptime monitors. */
  app.get(['/health', '/api/health'], async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'ok', environment: config.NODE_ENV, time: new Date().toISOString() });
    } catch (err) {
      logger.error({ err }, 'health check failed');
      res.status(503).json({ status: 'degraded', database: 'unreachable', time: new Date().toISOString() });
    }
  });

  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/api/health' || !req.url?.startsWith('/api') },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    serializers: { req: (req) => ({ method: req.method, url: String(req.url).split('?')[0] }), res: (res) => ({ statusCode: res.statusCode }) },
  }));

  const api = express.Router();
  api.use(rateLimit({
    windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => config.DISABLE_RATE_LIMIT === 'true',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } },
  }));
  api.use(express.json({ limit: '1mb' }));
  api.use(cookieParser());
  // State-changing requests must be JSON or multipart — never a plain cross-site form post.
  api.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const type = req.get('content-type') ?? '';
      const hasBody = Number(req.get('content-length') ?? 0) > 0;
      if (hasBody && !type.startsWith('application/json') && !type.startsWith('multipart/form-data')) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must be sent as JSON.');
      }
    }
    next();
  });
  api.use(loadSession);
  api.use(csrfProtection);
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(coreRouter);
  api.use(propertyRouter);
  api.use(financeRouter);
  api.use((req, _res, next) => next(new AppError(404, 'NOT_FOUND', `No such API endpoint: ${req.method} ${req.path}`)));
  app.use('/api/v1', api);

  // In production the same server delivers the built web app.
  const webDist = config.WEB_DIST ? resolve(config.WEB_DIST) : '';
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
