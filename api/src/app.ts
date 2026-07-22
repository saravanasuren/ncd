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
import { lookupsRouter } from './modules/lookups/routes.js';
import { approvalsRouter } from './modules/approvals/routes.js';
import { applicationsRouter } from './modules/applications/routes.js';
import { agentsRouter } from './modules/agents/routes.js';
import { allotmentsRouter } from './modules/allotments/routes.js';
import { payoutsRouter } from './modules/payouts/routes.js';
import { bgvRouter } from './modules/bgv/routes.js';
import { redemptionsRouter } from './modules/redemptions/routes.js';
import { incentivesRouter } from './modules/incentives/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { reportsRouter } from './modules/reports/routes.js';
import { portalRouter } from './modules/portal/routes.js';
import { integrationRouter } from './modules/integration/routes.js';
import { myRouter, agentLeadsRouter } from './modules/integration/my.js';
import { lockersRouter } from './modules/lockers/routes.js';
import { webhooksRouter } from './modules/webhooks/routes.js';
import { eventsRouter } from './modules/events/routes.js';
import { statementsRouter } from './modules/statements/routes.js';
import { auditRouter, systemRouter } from './modules/admin/routes.js';
import { importsRouter } from './modules/imports/routes.js';
import { authLimiter, otpLimiter, writeLimiter, integrationLimiter } from './middleware/rateLimit.js';
import { isProd } from './config.js';

export function createApp(): Express {
  const app = express();

  // Behind nginx in production → trust the first proxy hop so req.ip is real.
  if (isProd) app.set('trust proxy', 1);

  app.use(helmet({
    hsts: isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    contentSecurityPolicy: false, // the SPA is served by nginx, not Express
  }));
  app.use(
    cors({
      origin: config.WEB_ORIGIN,
      credentials: true,
    })
  );
  app.use(compression());
  // Upload routes carry base64 file payloads (~37% inflation on a 5 MB cap),
  // so they get a larger parser; everything else keeps the tight default.
  app.use(['/api/applications', '/api/customers', '/api/integration', '/api/portal'], express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  if (config.NODE_ENV !== 'test') app.use(morgan('tiny'));

  // Health — public, unauthenticated.
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'new-wealth-api', ts: new Date().toISOString() });
  });

  // Rate limits (docs/10 §3). Strict on credentials, looser on writes.
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/refresh', authLimiter);
  app.use('/api/auth/forgot-password', authLimiter);
  app.use('/api/auth/reset-password', authLimiter);
  app.use('/api/portal/otp', otpLimiter);
  app.use(['/api/integration', '/api/my', '/api/investor-leads'], integrationLimiter);
  app.use('/api', writeLimiter);

  // Integration façade: own key auth, no cookie/CSRF (LockerHub / DhanamFin).
  // Mounted BEFORE the CSRF guard so app clients don't need the browser header.
  app.use('/api/integration', integrationRouter);
  // Agent-app surface (contract B23): X-Integration-Key + X-Acting-As-Agent, no
  // cookie/CSRF — mounted here alongside the integration façade.
  app.use('/api/my', myRouter);
  app.use('/api/investor-leads', agentLeadsRouter);
  // Provider webhooks — own shared-secret auth, no cookie/CSRF (external callers).
  app.use('/api/webhooks', webhooksRouter);

  // CSRF on cookie-authed mutations, then attach the authenticated user.
  app.use('/api', csrfGuard);
  app.use('/api', attachUser);

  // Module routers.
  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/background-verification', bgvRouter);
  app.use('/api/lookups', lookupsRouter);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/applications', applicationsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/allotments', allotmentsRouter);
  app.use('/api/payouts', payoutsRouter);
  app.use('/api/bank-statements', statementsRouter);
  app.use('/api/redemptions', redemptionsRouter);
  app.use('/api/lockers', lockersRouter);
  app.use('/api/ncd-events', eventsRouter);
  app.use('/api/incentives', incentivesRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/imports', importsRouter);
  app.use('/api/portal', portalRouter);
  app.use('/api', productsRouter); // mounts /schemes, /series, /tds-rules, /banks, /holidays, /company-profile

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
