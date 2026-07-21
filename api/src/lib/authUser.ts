/** The authenticated principal attached to each request (docs/03, docs/13). */
import type { Permission, Role } from '@new-wealth/shared';

export interface AuthUser {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  branchIds: number[];
  agentId: number | null;
  customerId: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Set by fileTokenOr when a valid ?vt= file token authorised the request
       * (no session), so the handler can skip its session-based visibility check. */
      fileToken?: boolean;
    }
  }
}
