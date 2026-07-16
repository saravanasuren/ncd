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
import { leadsRouter } from './modules/leads/routes.js';
import { customersRouter } from './modules/customers/routes.js';
import { approvalsRouter } from './modules/approvals/routes.js';
import { applicationsRouter } from './modules/applications/routes.js';
import { allotmentsRouter } from './modules/allotments/routes.js';
import { payoutsRouter } from './modules/payouts/routes.js';
import { redemptionsRouter } from './modules/redemptions/routes.js';
import { incentivesRouter } from './modules/incentives/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { reportsRouter } from './modules/reports/routes.js';
import { portalRouter } from './modules/portal/routes.js';
import { integrationRouter } from './modules/integration/routes.js';

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

  // Integration façade: own key auth, no cookie/CSRF (LockerHub / DhanamFin).
  // Mounted BEFORE the CSRF guard so app clients don't need the browser header.
  app.use('/api/integration', integrationRouter);

  // CSRF on cookie-authed mutations, then attach the authenticated user.
  app.use('/api', csrfGuard);
  app.use('/api', attachUser);

  // Module routers.
  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/applications', applicationsRouter);
  app.use('/api/allotments', allotmentsRouter);
  app.use('/api/payouts', payoutsRouter);
  app.use('/api/redemptions', redemptionsRouter);
  app.use('/api/incentives', incentivesRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api', productsRouter); // mounts /schemes, /series, /tds-rules, /banks, /holidays, /company-profile

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
