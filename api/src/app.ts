/**
 * Express app assembly (docs/01 §2). Module routers mount here as they are
 * built (Phase 2+). Cross-cutting middleware first, health, then modules,
 * then 404 + error handler.
 */
import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: config.WEB_ORIGIN,
      credentials: true,
    })
  );
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  if (config.NODE_ENV !== 'test') app.use(morgan('tiny'));

  // Health — public, unauthenticated.
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'new-wealth-api', ts: new Date().toISOString() });
  });

  // --- module routers mount here (Phase 2+) ---
  // app.use('/api/auth', authRouter);
  // app.use('/api/customers', customersRouter);
  // ...

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
