import { prisma, Prisma } from '../db.js';
import { badRequest } from '../errors.js';

/**
 * Activity timeline of a record, assembled from the audit log: the record's own
 * entries plus those of closely related records (e.g. a tenant's contracts and payments).
 */
export async function timeline(orgId: string, entityType: string, entityId: string, take = 80) {
  const ids = new Set<string>([entityId]);
  if (entityType === 'Tenant') {
    const [contracts, payments] = await Promise.all([
      prisma.contract.findMany({ where: { orgId, tenantId: entityId }, select: { id: true } }),
      prisma.payment.findMany({ where: { orgId, tenantId: entityId }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 300 }),
    ]);
    for (const r of [...contracts, ...payments]) ids.add(r.id);
  } else if (entityType === 'Room') {
    const [contracts, payments, maintenance] = await Promise.all([
      prisma.contract.findMany({ where: { orgId, roomId: entityId }, select: { id: true } }),
      prisma.payment.findMany({ where: { orgId, roomId: entityId }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 300 }),
      prisma.maintenanceRequest.findMany({ where: { orgId, roomId: entityId }, select: { id: true } }),
    ]);
    for (const r of [...contracts, ...payments, ...maintenance]) ids.add(r.id);
  } else if (entityType === 'Contract') {
    const payments = await prisma.payment.findMany({ where: { orgId, contractId: entityId }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 300 });
    for (const r of payments) ids.add(r.id);
  } else if (!['Payment', 'Expense', 'MaintenanceRequest', 'Building', 'Invoice', 'User'].includes(entityType)) {
    throw badRequest('No timeline is available for this kind of record.');
  }
  const rows = await prisma.auditLog.findMany({
    where: { orgId, entityId: { in: [...ids] }, action: { notIn: ['REPORT_GENERATED'] } }, orderBy: { id: 'desc' }, take,
    select: { id: true, action: true, entityType: true, entityId: true, summary: true, userLabel: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, id: r.id.toString(), userLabel: r.userLabel?.replace(/ <.*>$/, '') ?? 'System' }));
}

export interface AuditFilter {
  userId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  q?: string;
}

export async function listAudit(orgId: string, f: AuditFilter, page: { page: number; pageSize: number }) {
  const where: Prisma.AuditLogWhereInput = {
    orgId, ...(f.userId ? { userId: f.userId } : {}), ...(f.action ? { action: f.action } : {}), ...(f.entityType ? { entityType: f.entityType } : {}), ...(f.entityId ? { entityId: f.entityId } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lt: new Date(f.to.getTime() + 86_400_000) } : {}) } } : {}),
    ...(f.q ? { OR: [{ summary: { contains: f.q } }, { userLabel: { contains: f.q } }] } : {}),
  };
  const [total, items, actions] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (page.page - 1) * page.pageSize, take: page.pageSize }),
    prisma.auditLog.findMany({ where: { orgId }, distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
  ]);
  return { items: items.map((i) => ({ ...i, id: i.id.toString() })), total, actions: actions.map((a) => a.action) };
}
