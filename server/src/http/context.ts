import type { Request } from 'express';
import type { PermissionKey } from '../auth/permissions.js';
import { forbidden, unauthorized } from '../errors.js';

/** The authenticated user performing an operation. Passed explicitly to every service. */
export interface Actor {
  userId: string;
  orgId: string;
  name: string;
  email: string;
  roles: string[];
  permissions: Set<string>;
  ip?: string;
  userAgent?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    sessionId?: string;
    csrfToken?: string;
  }
}

export function actorOf(req: Request): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

export function can(actor: Actor, permission: PermissionKey): boolean {
  return actor.permissions.has(permission);
}

export function assertCan(actor: Actor, permission: PermissionKey, message?: string): void {
  if (!can(actor, permission)) throw forbidden(message);
}
