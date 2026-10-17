import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config, isProd } from '../config.js';
import { prisma } from '../db.js';
import { badRequest } from '../errors.js';
import { actorOf } from '../http/context.js';
import { clientInfo, requireAuth, requirePermission, SESSION_COOKIE } from '../http/middleware.js';
import { paged, zEmail, zId, zOptionalDate, zOptionalId, zPage, zPhone, zRequiredText, zText, zTextNullable } from '../http/validation.js';
import * as auth from '../services/auth.js';
import { isEmailConfigured } from '../services/mailer.js';
import { channelStatus } from '../services/messages.js';
import * as notifications from '../services/notifications.js';
import { getOrg } from '../services/org.js';
import * as rbac from '../services/rbac.js';
import { dailyOperations, dashboard, reconcile } from '../services/reports.js';
import { globalSearch } from '../services/search.js';
import * as settings from '../services/settings.js';
import { listAudit, timeline } from '../services/timeline.js';
import * as users from '../services/users.js';
import { businessDate, endOfMonth, startOfMonth } from '../lib/dates.js';

export const coreRouter = Router();

const disabled = config.DISABLE_RATE_LIMIT === 'true';
/** Strict limit on credential endpoints to slow down password guessing. */
const authLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => disabled,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } },
});

// ───────────── Authentication ─────────────

const sessionCookie = { httpOnly: true, sameSite: 'lax' as const, secure: isProd, path: '/', maxAge: config.SESSION_TTL_HOURS * 3_600_000 };

coreRouter.post('/auth/login', authLimiter, async (req, res) => {
  // `login` is the e-mail address or the phone number on the account; `email` is still accepted from older clients.
  const body = z.object({ login: z.string().trim().max(160).optional(), email: z.string().trim().max(160).optional(), password: z.string().min(1).max(200) }).parse(req.body);
  const login = body.login || body.email;
  if (!login) throw badRequest('Enter your e-mail address or phone number.');
  const result = await auth.login(login, body.password, clientInfo(req));
  if (result.otp) {
    // Password accepted, but no session yet: the e-mailed code must be verified first.
    res.json({ ok: true, otpRequired: true, ...result.otp });
    return;
  }
  res.cookie(SESSION_COOKIE, result.session.token, sessionCookie);
  res.json({ ok: true, otpRequired: false, mustChangePassword: result.session.mustChangePassword });
});

const zChallenge = z.string().min(20).max(100);

coreRouter.post('/auth/otp/verify', authLimiter, async (req, res) => {
  const body = z.object({ challenge: zChallenge, code: z.string().regex(/^\d{4}$/, 'Enter the 4-digit code.') }).parse(req.body);
  const session = await auth.verifyLoginOtp(body.challenge, body.code, clientInfo(req));
  res.cookie(SESSION_COOKIE, session.token, sessionCookie);
  res.json({ ok: true, mustChangePassword: session.mustChangePassword });
});

coreRouter.post('/auth/otp/resend', authLimiter, async (req, res) => {
  const body = z.object({ challenge: zChallenge }).parse(req.body);
  res.json({ ok: true, ...(await auth.resendLoginOtp(body.challenge)) });
});

coreRouter.post('/auth/logout', requireAuth, async (req, res) => {
  await auth.logout(req.sessionId!, actorOf(req));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

coreRouter.get('/auth/me', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const [org, user, unread] = await Promise.all([
    getOrg(actor.orgId),
    prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { mustChangePassword: true, emailVerifiedAt: true, phone: true } }),
    notifications.unreadCount(actor.userId),
  ]);
  res.json({
    user: { id: actor.userId, name: actor.name, email: actor.email, roles: actor.roles, permissions: [...actor.permissions].sort(), ...user },
    organization: { id: org.id, name: org.name, currency: org.currency, timezone: org.timezone, isDemo: org.isDemo, today: businessDate(org.timezone).toISOString().slice(0, 10) },
    csrfToken: req.csrfToken, unreadNotifications: unread, environment: config.NODE_ENV,
  });
});

coreRouter.post('/auth/change-password', requireAuth, authLimiter, async (req, res) => {
  const body = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }).parse(req.body);
  await auth.changePassword(actorOf(req), req.sessionId!, body.currentPassword, body.newPassword);
  res.json({ ok: true });
});

coreRouter.post('/auth/forgot-password', authLimiter, async (req, res) => {
  const body = z.object({ email: zEmail }).parse(req.body);
  await auth.requestPasswordReset(body.email, clientInfo(req));
  // Same answer whether or not the account exists.
  res.json({
    ok: true, emailConfigured: isEmailConfigured(),
    message: isEmailConfigured()
      ? 'If an account exists for this address, a reset link has been e-mailed to it.'
      : 'E-mail delivery is not configured on this server. Ask your administrator to issue a password reset link from the Users screen.',
  });
});

coreRouter.post('/auth/reset-password', authLimiter, async (req, res) => {
  const body = z.object({ token: z.string().min(10).max(200), newPassword: z.string().min(1).max(200) }).parse(req.body);
  await auth.resetPassword(body.token, body.newPassword);
  res.json({ ok: true });
});

coreRouter.post('/auth/verify-email', authLimiter, async (req, res) => {
  const body = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
  await auth.verifyEmail(body.token);
  res.json({ ok: true });
});

// ───────────── Reference data for forms ─────────────

coreRouter.get('/meta', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const [org, buildings, methods, categories] = await Promise.all([
    getOrg(actor.orgId),
    prisma.building.findMany({ where: { orgId: actor.orgId }, select: { id: true, code: true, name: true, status: true }, orderBy: { name: 'asc' } }),
    settings.listMethods(actor.orgId), settings.listCategories(actor.orgId),
  ]);
  res.json({
    organization: { name: org.name, currency: org.currency, defaultDueDay: org.defaultDueDay, defaultGraceDays: org.defaultGraceDays, expiringSoonDays: org.expiringSoonDays },
    buildings, paymentMethods: methods, expenseCategories: categories, channels: channelStatus(),
  });
});

// ───────────── Dashboard, search, notifications ─────────────

const zBuildingFilter = z.object({ buildingId: zOptionalId });

coreRouter.get('/dashboard', requirePermission('dashboard.view'), async (req, res) => {
  res.json(await dashboard(actorOf(req), zBuildingFilter.parse(req.query).buildingId));
});

coreRouter.get('/dashboard/daily', requirePermission('dashboard.view'), async (req, res) => {
  res.json(await dailyOperations(actorOf(req), zBuildingFilter.parse(req.query).buildingId));
});

coreRouter.get('/dashboard/reconciliation', requirePermission('report.financial'), async (req, res) => {
  const actor = actorOf(req);
  const q = z.object({ from: zOptionalDate, to: zOptionalDate }).parse(req.query);
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  res.json(await reconcile(actor.orgId, q.from ?? startOfMonth(today), q.to ?? endOfMonth(today)));
});

coreRouter.get('/search', requireAuth, async (req, res) => {
  const q = z.object({ q: z.string().trim().max(100).default('') }).parse(req.query);
  res.json({ items: await globalSearch(actorOf(req), q.q) });
});

coreRouter.get('/notifications', requireAuth, async (req, res) => {
  const q = zPage.extend({ category: zText(20), unread: z.enum(['true', 'false']).optional() }).parse(req.query);
  const r = await notifications.listNotifications(actorOf(req).userId, { category: q.category, unread: q.unread === 'true' }, q);
  res.json({ ...paged(r.items, r.total, q), unread: r.unread, unreadByCategory: r.unreadByCategory });
});

coreRouter.get('/notifications/unread-count', requireAuth, async (req, res) => {
  res.json({ unread: await notifications.unreadCount(actorOf(req).userId) });
});

coreRouter.post('/notifications/read-all', requireAuth, async (req, res) => {
  const body = z.object({ category: zText(20) }).parse(req.body ?? {});
  res.json({ marked: await notifications.markAllRead(actorOf(req).userId, body.category) });
});

coreRouter.post('/notifications/:id/read', requireAuth, async (req, res) => {
  await notifications.markRead(actorOf(req).userId, zId.parse(req.params.id));
  res.json({ ok: true });
});

// ───────────── Users & roles ─────────────

coreRouter.get('/users', requirePermission('user.manage'), async (req, res) => {
  res.json({ items: await users.listUsers(actorOf(req).orgId) });
});

coreRouter.get('/staff', requirePermission('maintenance.manage', 'maintenance.view', 'user.manage', 'audit.view'), async (req, res) => {
  res.json({ items: await users.staffDirectory(actorOf(req).orgId) });
});

coreRouter.post('/users', requirePermission('user.manage'), async (req, res) => {
  const body = z.object({ email: zEmail, fullName: zRequiredText(160, 'Full name'), phone: z.preprocess((v) => (v === '' ? undefined : v), zPhone.optional()), password: z.string().min(1).max(200), roles: z.array(z.string().max(40)).min(1) }).parse(req.body);
  res.status(201).json(await users.createUser(actorOf(req), body));
});

coreRouter.patch('/users/:id', requirePermission('user.manage'), async (req, res) => {
  const body = z.object({ fullName: zRequiredText(160).optional(), phone: z.preprocess((v) => (v === '' ? null : v), zPhone.nullable().optional()), status: z.enum(['ACTIVE', 'DISABLED']).optional(), roles: z.array(z.string().max(40)).optional() }).parse(req.body);
  res.json({ id: await users.updateUser(actorOf(req), zId.parse(req.params.id), body) });
});

coreRouter.delete('/users/:id', requirePermission('user.manage'), async (req, res) => {
  await users.removeUser(actorOf(req), zId.parse(req.params.id));
  res.json({ ok: true });
});

coreRouter.post('/users/:id/reset-link', requirePermission('user.manage'), async (req, res) => {
  res.json(await auth.issueResetLink(actorOf(req), zId.parse(req.params.id)));
});

coreRouter.post('/users/:id/mark-email-verified', requirePermission('user.manage'), async (req, res) => {
  await auth.markEmailVerified(actorOf(req), zId.parse(req.params.id));
  res.json({ ok: true });
});
coreRouter.post('/users/:id/verification-link', requirePermission('user.manage'), async (req, res) => {
  const actor = actorOf(req);
  const id = zId.parse(req.params.id);
  await prisma.user.findFirstOrThrow({ where: { id, orgId: actor.orgId, deletedAt: null } });
  res.json(await auth.issueVerification(id));
});

coreRouter.get('/roles', requirePermission('user.manage', 'role.manage'), async (_req, res) => {
  res.json({ roles: await rbac.listRoles(), permissions: rbac.permissionCatalog() });
});

coreRouter.post('/roles', requirePermission('role.manage'), async (req, res) => {
  const body = z.object({ name: zRequiredText(80, 'Role name'), description: zText(255), permissions: z.array(z.string().max(60)) }).parse(req.body);
  res.status(201).json(await rbac.createRole(actorOf(req), body));
});

coreRouter.put('/roles/:id/permissions', requirePermission('role.manage'), async (req, res) => {
  const body = z.object({ permissions: z.array(z.string().max(60)) }).parse(req.body);
  res.json({ permissions: await rbac.setRolePermissions(actorOf(req), zId.parse(req.params.id), body.permissions) });
});

// ───────────── Settings ─────────────

coreRouter.get('/settings', requirePermission('settings.manage'), async (req, res) => {
  const actor = actorOf(req);
  const [organization, categories, methods] = await Promise.all([getOrg(actor.orgId), settings.listCategories(actor.orgId), settings.listMethods(actor.orgId)]);
  res.json({ organization, categories, methods, integrations: { email: isEmailConfigured(), sms: false, whatsapp: false, ebm: false } });
});

const zPrefix = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'Use 1–10 letters or digits.');

coreRouter.patch('/settings/organization', requirePermission('settings.manage'), async (req, res) => {
  const body = z.object({
    name: zRequiredText(160, 'Organization name').optional(), legalName: zTextNullable(200), tin: zTextNullable(40), address: zTextNullable(255), phone: zTextNullable(40),
    email: z.preprocess((v) => (v === '' ? null : v), zEmail.nullable().optional()),
    defaultDueDay: z.coerce.number().int().min(1).max(31).optional(), defaultGraceDays: z.coerce.number().int().min(0).max(90).optional(),
    expiringSoonDays: z.coerce.number().int().min(1).max(365).optional(), dueSoonDays: z.coerce.number().int().min(0).max(31).optional(),
    receiptPrefix: zPrefix.optional(), invoicePrefix: zPrefix.optional(), contractPrefix: zPrefix.optional(), notifyInApp: z.boolean().optional(), proratePartialMonths: z.boolean().optional(), requirePaymentVerification: z.boolean().optional(),
  }).parse(req.body);
  res.json(await settings.updateOrganization(actorOf(req), body));
});

coreRouter.post('/settings/categories', requirePermission('settings.manage'), async (req, res) => {
  const body = z.object({ id: zOptionalId, name: zText(80), isActive: z.boolean().optional() }).parse(req.body);
  res.json(await settings.saveCategory(actorOf(req), body));
});

coreRouter.post('/settings/payment-methods', requirePermission('settings.manage'), async (req, res) => {
  const body = z.object({ id: zOptionalId, code: zText(30), name: zText(80), requiresReference: z.boolean().optional(), isActive: z.boolean().optional() }).parse(req.body);
  res.json(await settings.saveMethod(actorOf(req), body));
});

// ───────────── Audit log & timelines ─────────────

coreRouter.get('/audit-logs', requirePermission('audit.view'), async (req, res) => {
  const q = zPage.extend({ userId: zOptionalId, action: zText(60), entityType: zText(40), entityId: zText(40), from: zOptionalDate, to: zOptionalDate }).parse(req.query);
  const r = await listAudit(actorOf(req).orgId, q, q);
  res.json({ ...paged(r.items, r.total, q), actions: r.actions });
});

const TIMELINE_PERMISSION = { Tenant: 'tenant.view', Room: 'room.view', Contract: 'contract.view', Payment: 'payment.view', Expense: 'expense.view', MaintenanceRequest: 'maintenance.view', Building: 'building.view', Invoice: 'invoice.view', User: 'user.manage' } as const;

coreRouter.get('/timeline', requireAuth, async (req, res) => {
  const actor = actorOf(req);
  const q = z.object({ entityType: z.enum(Object.keys(TIMELINE_PERMISSION) as [keyof typeof TIMELINE_PERMISSION, ...Array<keyof typeof TIMELINE_PERMISSION>]), entityId: zId }).parse(req.query);
  if (!actor.permissions.has(TIMELINE_PERMISSION[q.entityType])) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to view this history.' } });
    return;
  }
  res.json({ items: await timeline(actor.orgId, q.entityType, q.entityId) });
});

