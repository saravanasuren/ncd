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
import { attachUser } from './middleware/auth.js';
import { csrfGuard } from './middleware/csrf.js';
import { authRouter } from './modules/auth/routes.js';
import { settingsRouter } from './modules/settings/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { productsRouter } from './modules/products/routes.js';

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

  // CSRF on cookie-authed mutations, then attach the authenticated user.
  app.use('/api', csrfGuard);
  app.use('/api', attachUser);

  // Module routers.
  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api', productsRouter); // mounts /schemes, /series, /tds-rules, /banks, /holidays, /company-profile

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
