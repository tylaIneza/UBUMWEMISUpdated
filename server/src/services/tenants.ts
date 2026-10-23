import { inTransaction, prisma, Prisma } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { can, type Actor } from '../http/context.js';
import { formatMoney, money, sum, ZERO } from '../lib/money.js';
import { parsePhone, phoneSearchDigits } from '../lib/phone.js';
import { idNumberProblem, normalizeIdNumber, normalizeTin, tinProblem, type IdType } from '../lib/identity.js';
import { isoDate, periodLabel } from '../lib/dates.js';
import { audit, diff } from './audit.js';
import { deriveStatus } from './charges.js';
import { createContractTx, OPEN_END, terminateContract } from './contracts.js';
import { orgToday } from './org.js';
import { assertPeriodOpen } from './periods.js';
import { BILLABLE_STATUSES, endReservation, OCCUPYING_STATUSES } from './property.js';
import { clearReconcileCache } from './reconcileCache.js';

export interface TenantInput {
  fullName: string;
  idType?: string;
  idNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  businessName?: string | null;
  tin?: string | null;
  district?: string | null;
  sector?: string | null;
  cell?: string | null;
  village?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  notes?: string | null;
}

/** Finds the tenant (if any) already registered with this document number. */
export async function findByIdNumber(orgId: string, idNumber: string, exceptId?: string) {
  return prisma.tenant.findFirst({
    where: { orgId, idNumber: normalizeIdNumber(idNumber), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, fullName: true, phone: true, status: true },
  });
}

/** Rejects an invalid number, or one that already belongs to another tenant (with a message naming them). */
async function assertIdNumber(orgId: string, idType: IdType, idNumber: string, exceptId?: string) {
  const problem = idNumberProblem(idType, idNumber);
  if (problem) throw badRequest(problem, 'INVALID_ID_NUMBER', { fields: { idNumber: problem } });
  const existing = await findByIdNumber(orgId, idNumber, exceptId);
  if (existing) {
    throw conflict(`ID number ${normalizeIdNumber(idNumber)} is already registered to ${existing.fullName}. One ID or passport number can belong to only one tenant — open that tenant instead of registering them again.`, 'DUPLICATE_TENANT',
      { fields: { idNumber: `Already registered to ${existing.fullName}.` }, tenantId: existing.id, fullName: existing.fullName });
  }
}

/** Finds the tenant (if any) already registered with this TIN. */
export async function findByTin(orgId: string, tin: string, exceptId?: string) {
  return prisma.tenant.findFirst({
    where: { orgId, tin: normalizeTin(tin), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, fullName: true, phone: true, status: true },
  });
}

/** A TIN is the number on one RDB certificate, so it can belong to only one tenant. */
async function assertTin(orgId: string, tin: string, exceptId?: string) {
  const problem = tinProblem(tin);
  if (problem) throw badRequest(problem, 'INVALID_TIN', { fields: { tin: problem } });
  const existing = await findByTin(orgId, tin, exceptId);
  if (existing) {
    throw conflict(`TIN ${normalizeTin(tin)} is already registered to ${existing.fullName}. One TIN (RDB certificate) can belong to only one tenant.`, 'DUPLICATE_TIN',
      { fields: { tin: `Already registered to ${existing.fullName}.` }, tenantId: existing.id, fullName: existing.fullName });
  }
}

/** A room the tenant moves into at registration: they occupy it and pay rent without a contract until one is given. */
export interface TenancyInput {
  roomId: string;
  startDate: Date;
}

/**
 * Registers a tenant. Only the name is required; the other details can be added later (the contract prints
 * blank lines for any that are missing). With `tenancy`, the tenant also occupies that room from the given day,
 * without a contract, so rent is billed and payments can be recorded.
 */
export async function createTenant(actor: Actor, input: TenantInput, tenancy?: TenancyInput) {
  const idType = (input.idType ?? 'NATIONAL_ID') as IdType;
  if (input.idNumber) await assertIdNumber(actor.orgId, idType, input.idNumber);
  if (input.tin) await assertTin(actor.orgId, input.tin);
  if (tenancy && !can(actor, 'contract.manage')) throw forbidden('You are not authorised to assign a room to a tenant.');
  return inTransaction(async (tx) => {
    // The unique index on (organization, ID number) is the final guarantee if two people register the same person at once.
    const tenant = await tx.tenant.create({ data: { orgId: actor.orgId, ...input, idNumber: input.idNumber ? normalizeIdNumber(input.idNumber) : null, tin: input.tin ? normalizeTin(input.tin) : null, idType, status: 'INACTIVE' } });
    await audit(tx, actor, { action: 'TENANT_CREATED', entityType: 'Tenant', entityId: tenant.id, summary: `Tenant ${tenant.fullName} registered`, newValue: tenant });
    if (tenancy) await createContractTx(tx, actor, { tenantId: tenant.id, roomId: tenancy.roomId, startDate: tenancy.startDate, endDate: OPEN_END, activate: true, withLease: false });
    return tenant;
  });
}

export async function updateTenant(actor: Actor, id: string, input: Partial<TenantInput>) {
  const current = await prisma.tenant.findFirst({ where: { id, orgId: actor.orgId } });
  if (!current) throw notFound('Tenant');
  const idType = (input.idType ?? current.idType) as IdType;
  const idNumber = input.idNumber === undefined ? current.idNumber : input.idNumber;
  // Check the number when it (or its type) changes, so older records can still be edited until they are corrected.
  if (idNumber && (normalizeIdNumber(idNumber) !== current.idNumber || idType !== current.idType)) await assertIdNumber(actor.orgId, idType, idNumber, id);
  if (input.tin && normalizeTin(input.tin) !== current.tin) await assertTin(actor.orgId, input.tin, id);
  return inTransaction(async (tx) => {
    const before = await tx.tenant.findFirst({ where: { id, orgId: actor.orgId } });
    if (!before) throw notFound('Tenant');
    const tenant = await tx.tenant.update({ where: { id }, data: { ...input, idNumber: input.idNumber === undefined ? undefined : input.idNumber ? normalizeIdNumber(input.idNumber) : null, tin: input.tin ? normalizeTin(input.tin) : input.tin } });
    const d = diff(before, tenant);
    if (d) await audit(tx, actor, { action: 'TENANT_UPDATED', entityType: 'Tenant', entityId: id, summary: `Tenant ${tenant.fullName} updated`, oldValue: d.old, newValue: d.new });
    return tenant;
  });
}

/**
 * Manual status changes. ACTIVE / FORMER follow from contracts automatically; staff can
 * only mark a tenant without a current contract INACTIVE, or (with authority) blacklist.
 */
export async function setTenantStatus(actor: Actor, id: string, status: 'INACTIVE' | 'BLACKLISTED' | 'FORMER', reason?: string) {
  return inTransaction(async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { id, orgId: actor.orgId } });
    if (!tenant) throw notFound('Tenant');
    if (tenant.status === 'ARCHIVED') throw conflict(`${tenant.fullName} is archived. Restore them first.`, 'TENANT_ARCHIVED');
    const blacklistChange = status === 'BLACKLISTED' || tenant.status === 'BLACKLISTED';
    if (blacklistChange) {
      if (!can(actor, 'tenant.blacklist')) throw forbidden('You are not authorised to change a tenant\'s blacklist status.');
      if (!reason?.trim()) throw badRequest('A reason is required to change blacklist status.', 'REASON_REQUIRED');
    }
    const occupying = await tx.contract.count({ where: { tenantId: id, status: { in: [...OCCUPYING_STATUSES] } } });
    if (occupying > 0 && status !== 'BLACKLISTED') throw conflict('This tenant has an active contract. Terminate the contract first.', 'TENANT_ACTIVE');
    const updated = await tx.tenant.update({ where: { id }, data: { status, statusReason: reason?.trim() || null } });
    await audit(tx, actor, { action: status === 'BLACKLISTED' ? 'TENANT_BLACKLISTED' : 'TENANT_STATUS_CHANGED', entityType: 'Tenant', entityId: id, summary: `Tenant ${tenant.fullName}: ${tenant.status} → ${status}${reason ? ` (${reason})` : ''}`, oldValue: { status: tenant.status }, newValue: { status, reason } });
    return updated;
  });
}

/**
 * Archives a tenant who should no longer appear in the system: their tenancy ends today (as a move-out, so the room is
 * free and no further rent is billed), any rent still owed is waived, active reservations are cancelled, and the tenant
 * is hidden from lists, search and reminders. Payments they made stay in the books and in every total and report.
 * Months already owed must lie in open accounting periods; this is checked before anything is changed.
 */
export async function archiveTenant(actor: Actor, id: string, reason: string) {
  const tenant = await prisma.tenant.findFirst({ where: { id, orgId: actor.orgId } });
  if (!tenant) throw notFound('Tenant');
  if (tenant.status === 'ARCHIVED') throw conflict(`${tenant.fullName} is already archived.`, 'ALREADY_ARCHIVED');
  if (!reason.trim()) throw badRequest('Give a reason for archiving.', 'REASON_REQUIRED');
  const today = await orgToday(actor.orgId);
  const occupying = await prisma.contract.findMany({ where: { tenantId: id, status: { in: [...OCCUPYING_STATUSES] } } });
  const notStarted = occupying.find((c) => c.startDate > today);
  if (notStarted) {
    throw conflict(`${tenant.fullName}'s tenancy ${notStarted.contractNumber} only starts on ${isoDate(notStarted.startDate)}. Correct its start date first, or archive the tenant on or after that day.`, 'NOT_STARTED');
  }
  const owing = await prisma.rentCharge.findMany({ where: { tenantId: id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, period: { lte: today } }, select: { period: true } });
  for (const c of owing) await assertPeriodOpen(prisma, actor.orgId, c.period, `The unpaid rent for ${periodLabel(c.period)}`);

  for (const c of occupying) await terminateContract(actor, c.id, { moveOutDate: today, reason: `Tenant archived: ${reason.trim()}` });
  const reservations = await prisma.reservation.findMany({ where: { tenantId: id, status: 'ACTIVE' }, select: { id: true } });
  for (const r of reservations) await endReservation(actor, actor.orgId, r.id, 'CANCELLED');

  const archived = await inTransaction(async (tx) => {
    const open = await tx.rentCharge.findMany({ where: { tenantId: id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, orderBy: { period: 'asc' } });
    const waived: Array<{ period: string; amount: string }> = [];
    for (const charge of open) {
      await assertPeriodOpen(tx, actor.orgId, charge.period, `The unpaid rent for ${periodLabel(charge.period)}`);
      const amount = money(charge.balance);
      const amountWaived = money(charge.amountWaived).plus(amount);
      const status = deriveStatus({ amountDue: money(charge.amountDue), amountPaid: money(charge.amountPaid), amountWaived, overdueFrom: charge.overdueFrom }, today);
      await tx.rentCharge.update({ where: { id: charge.id }, data: { amountWaived, balance: ZERO, status, note: `Waived ${formatMoney(amount)}: tenant archived — ${reason.trim()}`.slice(0, 255) } });
      waived.push({ period: isoDate(charge.period), amount: amount.toFixed(2) });
    }
    await tx.contract.deleteMany({ where: { tenantId: id, status: 'DRAFT' } });
    const updated = await tx.tenant.update({ where: { id }, data: { status: 'ARCHIVED', statusReason: reason.trim().slice(0, 255), archivedAt: new Date() } });
    const total = sum(waived.map((w) => w.amount));
    await audit(tx, actor, {
      action: 'TENANT_ARCHIVED', entityType: 'Tenant', entityId: id,
      summary: `Tenant ${tenant.fullName} archived: ${occupying.length} tenancy(ies) ended ${isoDate(today)}, ${waived.length ? `${formatMoney(total)} unpaid rent waived` : 'nothing owed'}. Reason: ${reason.trim()}`,
      oldValue: { status: tenant.status }, newValue: { status: 'ARCHIVED', endedContracts: occupying.map((c) => c.contractNumber), waived, reason: reason.trim() },
    });
    return updated;
  });
  clearReconcileCache(actor.orgId);
  return archived;
}

/** Archived tenants (and their contracts and payments) exist only for those allowed to manage the archive. */
export async function assertTenantVisible(actor: Actor, tenantId: string): Promise<void> {
  if (can(actor, 'tenant.archive')) return;
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, orgId: actor.orgId }, select: { status: true } });
  if (tenant?.status === 'ARCHIVED') throw notFound('Tenant');
}

/** Brings an archived tenant back into the lists as a former tenant. Ended tenancies and waivers stay as they are. */
export async function restoreTenant(actor: Actor, id: string) {
  return inTransaction(async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { id, orgId: actor.orgId } });
    if (!tenant) throw notFound('Tenant');
    if (tenant.status !== 'ARCHIVED') throw conflict(`${tenant.fullName} is not archived.`, 'NOT_ARCHIVED');
    const updated = await tx.tenant.update({ where: { id }, data: { status: 'FORMER', statusReason: null, archivedAt: null } });
    await audit(tx, actor, { action: 'TENANT_RESTORED', entityType: 'Tenant', entityId: id, summary: `Tenant ${tenant.fullName} restored from the archive (now a former tenant)`, oldValue: { status: 'ARCHIVED' }, newValue: { status: 'FORMER' } });
    return updated;
  });
}

export interface TenantFilter {
  q?: string;
  status?: string;
  buildingId?: string;
  floorId?: string;
  withArrears?: boolean;
}

export async function listTenants(orgId: string, f: TenantFilter, page: { page: number; pageSize: number }, sort?: string, dir: 'asc' | 'desc' = 'asc') {
  const where: Prisma.TenantWhereInput = {
    orgId,
    // Archived tenants are listed only when asked for (status=ARCHIVED, allowed by the route).
    ...(f.status ? { status: f.status as Prisma.TenantWhereInput['status'] } : { status: { not: 'ARCHIVED' } }),
    ...(f.buildingId || f.floorId
      ? { contracts: { some: { status: { in: [...OCCUPYING_STATUSES] }, ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.floorId ? { floorId: f.floorId } : {}) } } }
      : {}),
    ...(f.withArrears ? { charges: { some: { status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } } } } : {}),
    ...(f.q
      ? { OR: [{ fullName: { contains: f.q } }, { phone: { contains: phoneSearchDigits(f.q) ?? f.q } }, { idNumber: { contains: f.q } }, { businessName: { contains: f.q } }, { email: { contains: f.q } }] }
      : {}),
  };
  const [total, tenants] = await Promise.all([
    prisma.tenant.count({ where }),
    prisma.tenant.findMany({
      where, orderBy: sort === 'created' ? { createdAt: dir } : { fullName: dir }, skip: (page.page - 1) * page.pageSize, take: page.pageSize,
      include: {
        contracts: {
          where: { status: { in: [...OCCUPYING_STATUSES] } },
          select: { id: true, contractNumber: true, status: true, monthlyRent: true, endDate: true, room: { select: { id: true, number: true } }, floor: { select: { name: true } }, building: { select: { id: true, name: true } } },
        },
      },
    }),
  ]);
  const balances = await prisma.rentCharge.groupBy({ by: ['tenantId'], where: { tenantId: { in: tenants.map((t) => t.id) }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, _sum: { balance: true } });
  const map = new Map(balances.map((b) => [b.tenantId, money(b._sum.balance)]));
  return { items: tenants.map(({ contracts, ...t }) => ({ ...t, currentContracts: contracts, outstanding: map.get(t.id) ?? ZERO })), total };
}

export async function tenantDetail(orgId: string, id: string) {
  const tenant = await prisma.tenant.findFirst({
    where: { id, orgId },
    include: {
      contracts: {
        orderBy: { startDate: 'desc' },
        include: { room: { select: { id: true, number: true } }, floor: { select: { id: true, name: true } }, building: { select: { id: true, name: true } } },
      },
    },
  });
  if (!tenant) throw notFound('Tenant');
  const today = await orgToday(orgId);
  const open = await prisma.rentCharge.findMany({ where: { tenantId: id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, select: { balance: true, overdueFrom: true, contractId: true } });
  const [paid, credit, lastPayment] = await Promise.all([
    prisma.payment.aggregate({ where: { tenantId: id }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { tenantId: id, type: 'PAYMENT', status: 'POSTED' }, _sum: { unallocatedAmount: true } }),
    prisma.payment.findFirst({ where: { tenantId: id, type: 'PAYMENT', status: 'POSTED' }, orderBy: { paidAt: 'desc' }, select: { paidAt: true, amount: true } }),
  ]);
  const current = tenant.contracts.filter((c) => (OCCUPYING_STATUSES as readonly string[]).includes(c.status));
  const byContract = new Map<string, ReturnType<typeof money>>();
  for (const c of open) byContract.set(c.contractId, (byContract.get(c.contractId) ?? ZERO).plus(c.balance));
  return {
    ...tenant,
    idNumberProblem: tenant.idNumber ? idNumberProblem(tenant.idType as IdType, tenant.idNumber) : null,
    phoneProblem: !tenant.phone || parsePhone(tenant.phone).e164 === tenant.phone ? null : (parsePhone(tenant.phone).problem ?? 'Saved in an old format.'),
    contracts: tenant.contracts.map((c) => ({ ...c, outstanding: byContract.get(c.id) ?? ZERO, billable: (BILLABLE_STATUSES as readonly string[]).includes(c.status) })),
    currentContracts: current,
    financial: {
      outstanding: sum(open.map((c) => c.balance)),
      overdue: sum(open.filter((c) => c.overdueFrom < today).map((c) => c.balance)),
      totalPaid: money(paid._sum.amount), credit: money(credit._sum.unallocatedAmount),
      monthlyRent: sum(current.map((c) => c.monthlyRent)), lastPayment,
    },
  };
}

export interface LedgerFilter {
  tenantId?: string;
  contractId?: string;
  roomId?: string;
  buildingId?: string;
  floorId?: string;
  status?: string;
  from?: Date;
  to?: Date;
  overdueOnly?: boolean;
  /** Only rent whose due date has passed and is not fully paid (unpaid, partly paid or overdue). */
  owingOnly?: boolean;
  includeVoid?: boolean;
  /** Include rent of archived tenants (only when the viewer may see them and asked for one tenant or contract). */
  includeArchived?: boolean;
}

/** Rent ledger rows (one per billed month) with the payments applied to each. */
export async function rentLedger(orgId: string, f: LedgerFilter, page: { page: number; pageSize: number }, dir: 'asc' | 'desc' = 'desc') {
  const today = await orgToday(orgId);
  const where: Prisma.RentChargeWhereInput = {
    orgId,
    ...(f.tenantId ? { tenantId: f.tenantId } : {}), ...(f.contractId ? { contractId: f.contractId } : {}),
    ...(f.roomId ? { roomId: f.roomId } : {}), ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.floorId ? { floorId: f.floorId } : {}),
    ...(f.status ? { status: f.status as Prisma.RentChargeWhereInput['status'] } : f.includeVoid ? {} : { status: { not: 'VOID' } }),
    ...(f.overdueOnly ? { balance: { gt: 0 }, overdueFrom: { lt: today }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } } : {}),
    // In AND so it combines with the status filter above instead of replacing it.
    // Due date already passed — the same rule as the arrears report, so its PDF matches this list.
    ...(f.owingOnly ? { AND: [{ balance: { gt: 0 }, dueDate: { lt: today }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }] } : {}),
    ...(f.from || f.to ? { period: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(f.includeArchived ? {} : { tenant: { status: { not: 'ARCHIVED' } } }),
  };
  const [total, items, totals] = await Promise.all([
    prisma.rentCharge.count({ where }),
    prisma.rentCharge.findMany({
      where, orderBy: [{ period: dir }, { createdAt: 'asc' }], skip: (page.page - 1) * page.pageSize, take: page.pageSize,
      include: {
        tenant: { select: { id: true, fullName: true, phone: true } }, room: { select: { id: true, number: true } },
        floor: { select: { name: true } }, building: { select: { id: true, name: true } },
        contract: { select: { id: true, contractNumber: true, status: true } },
        allocations: {
          orderBy: { createdAt: 'asc' },
          include: { payment: { select: { id: true, type: true, status: true, paidAt: true, amount: true, reference: true, method: { select: { name: true } }, receipt: { select: { receiptNumber: true } }, recordedBy: { select: { fullName: true } } } } },
        },
      },
    }),
    prisma.rentCharge.aggregate({ where, _sum: { amountDue: true, amountPaid: true, amountWaived: true, balance: true } }),
  ]);
  return {
    items: items.map((c) => ({ ...c, isOverdue: money(c.balance).greaterThan(0) && c.overdueFrom < today && c.status !== 'VOID', daysOverdue: money(c.balance).greaterThan(0) && c.overdueFrom < today ? Math.round((today.getTime() - c.overdueFrom.getTime()) / 86_400_000) : 0 })),
    total,
    totals: { amountDue: money(totals._sum.amountDue), amountPaid: money(totals._sum.amountPaid), amountWaived: money(totals._sum.amountWaived), balance: money(totals._sum.balance) },
  };
}
