import { prisma, type Db } from '../db.js';
import type { PermissionKey } from '../auth/permissions.js';
import type { Notification } from '../generated/prisma/client.js';
import { notFound } from '../errors.js';
import { logger } from '../logger.js';

export interface NotificationInput {
  category: Notification['category'];
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  /** The same key is delivered to a user at most once. */
  dedupeKey: string;
}

/**
 * In-app notification channel. Other channels (e-mail, SMS, WhatsApp) can be added by
 * implementing another delivery function behind `notifyUsers`; none is faked here.
 */
export async function notifyUsers(db: Db, userIds: string[], n: NotificationInput): Promise<void> {
  if (!userIds.length) return;
  await db.notification.createMany({
    data: userIds.map((userId) => ({ userId, category: n.category, title: n.title.slice(0, 160), body: n.body.slice(0, 500), entityType: n.entityType ?? null, entityId: n.entityId ?? null, dedupeKey: n.dedupeKey.slice(0, 120) })),
    skipDuplicates: true,
  });
}

/** Notifies every active user who holds the given permission. */
export async function notifyPermission(db: Db, orgId: string, permission: PermissionKey, n: NotificationInput, excludeUserId?: string): Promise<void> {
  try {
    const org = await db.organization.findUnique({ where: { id: orgId }, select: { notifyInApp: true } });
    if (!org?.notifyInApp) return;
    const users = await db.user.findMany({
      where: { orgId, status: 'ACTIVE', deletedAt: null, id: excludeUserId ? { not: excludeUserId } : undefined, roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } } },
      select: { id: true },
    });
    await notifyUsers(db, users.map((u) => u.id), n);
  } catch (err) {
    // A notification failure must never fail the business operation that triggered it.
    logger.warn({ err, dedupeKey: n.dedupeKey }, 'notification could not be created');
  }
}

export async function listNotifications(userId: string, f: { category?: string; unread?: boolean }, page: { page: number; pageSize: number }) {
  const where = { userId, ...(f.category ? { category: f.category as Notification['category'] } : {}), ...(f.unread ? { readAt: null } : {}) };
  const [total, items, unread, byCategory] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page.page - 1) * page.pageSize, take: page.pageSize }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.groupBy({ by: ['category'], where: { userId, readAt: null }, _count: { _all: true } }),
  ]);
  return { items, total, unread, unreadByCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._count._all])) };
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markRead(userId: string, id: string) {
  const result = await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  if (result.count === 0 && !(await prisma.notification.count({ where: { id, userId } }))) throw notFound('Notification');
}

export async function markAllRead(userId: string, category?: string): Promise<number> {
  const result = await prisma.notification.updateMany({ where: { userId, readAt: null, ...(category ? { category: category as Notification['category'] } : {}) }, data: { readAt: new Date() } });
  return result.count;
}
