import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PermissionKey } from '../auth/permissions.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import { resolveSession } from '../services/auth.js';

export const SESSION_COOKIE = 'rpms_sid';

export function clientInfo(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

/** Loads the acting user from the session cookie (if any). Does not reject anonymous requests. */
export const loadSession: RequestHandler = async (req, _res, next) => {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (token) {
    const resolved = await resolveSession(token, clientInfo(req));
    if (resolved) {
      req.actor = resolved.actor;
      req.sessionId = resolved.sessionId;
      req.csrfToken = resolved.csrfToken;
    }
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.actor) throw unauthorized();
  next();
};

/** Route guard: the user must hold at least one of the listed permissions. Enforced server-side on every call. */
export function requirePermission(...anyOf: PermissionKey[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) throw unauthorized();
    if (!anyOf.some((p) => req.actor!.permissions.has(p))) throw forbidden();
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-authenticated requests: every state-changing request must
 * carry the session's CSRF token in the X-CSRF-Token header (a header a cross-site
 * form cannot set). The cookie is also SameSite=Lax as a second layer.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || !req.actor) return next();
  const sent = req.get('x-csrf-token') ?? '';
  const expected = req.csrfToken ?? '';
  const ok = sent.length === expected.length && expected.length > 0 && timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) throw new AppError(403, 'CSRF', 'Your session could not be verified. Please reload the page and try again.');
  next();
};
