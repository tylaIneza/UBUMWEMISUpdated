import { inTransaction, prisma, Prisma } from '../db.js';
import type { Invoice } from '../generated/prisma/client.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { money } from '../lib/money.js';
import { audit } from './audit.js';

/**
 * EBM / tax-invoice tracking. The EBM reference is typed in by staff after issuing the
 * invoice on the official EBM device/software. No RRA integration is configured, so
 * this module records and monitors — it never claims to have issued an EBM invoice.
 */
const TRANSITIONS: Record<Invoice['status'], Invoice['status'][]> = {
  PENDING: ['GENERATED', 'ISSUED', 'FAILED', 'CANCELLED'],
  GENERATED: ['ISSUED', 'FAILED', 'CANCELLED'],
  FAILED: ['PENDING', 'GENERATED', 'ISSUED', 'CANCELLED'],
  ISSUED: ['CANCELLED'],
  CANCELLED: [],
};

export async function updateInvoice(actor: Actor, id: string, input: { status?: Invoice['status']; ebmReference?: string | null; statusNote?: string | null }) {
  return inTransaction(async (tx) => {
    const before = await tx.invoice.findFirst({ where: { id, orgId: actor.orgId }, include: { payment: { select: { status: true } } } });
    if (!before) throw notFound('Invoice');
    const status = input.status ?? before.status;
    if (status !== before.status && !TRANSITIONS[before.status].includes(status)) {
      throw conflict(`An invoice that is ${before.status.toLowerCase()} cannot be changed to ${status.toLowerCase()}.`, 'INVALID_TRANSITION');
    }
    if (before.payment.status === 'REVERSED' && status !== 'CANCELLED') throw conflict('The payment behind this invoice was reversed; the invoice can only be cancelled.');
    const ebmReference = input.ebmReference === undefined ? before.ebmReference : input.ebmReference?.trim() || null;
    if (status === 'ISSUED' && !ebmReference) throw badRequest('Enter the EBM reference before marking the invoice as issued.', 'EBM_REQUIRED');
    if ((status === 'FAILED' || status === 'CANCELLED') && status !== before.status && !input.statusNote?.trim()) throw badRequest('Give a reason.', 'REASON_REQUIRED');
    const invoice = await tx.invoice.update({ where: { id }, data: { status, ebmReference, statusNote: input.statusNote === undefined ? before.statusNote : input.statusNote?.trim() || null, updatedById: actor.userId } });
    await audit(tx, actor, {
      action: 'INVOICE_UPDATED', entityType: 'Invoice', entityId: id, summary: `Invoice ${before.invoiceNumber}: ${before.status} → ${status}${ebmReference ? ` (EBM ${ebmReference})` : ''}`,
      oldValue: { status: before.status, ebmReference: before.ebmReference }, newValue: { status, ebmReference, note: input.statusNote },
    });
    return invoice;
  });
}

export interface InvoiceFilter {
  buildingId?: string;
  tenantId?: string;
  status?: string;
  missingEbm?: boolean;
  from?: Date;
  to?: Date;
  q?: string;
}

/** Invoices that still need an EBM reference: live payment, no reference, not cancelled. */
export const missingEbmWhere = (orgId: string, buildingId?: string): Prisma.InvoiceWhereInput => ({
  orgId, ebmReference: null, status: { in: ['PENDING', 'GENERATED', 'FAILED'] }, payment: { status: 'POSTED' }, ...(buildingId ? { buildingId } : {}),
});

export function invoiceWhere(orgId: string, f: InvoiceFilter): Prisma.InvoiceWhereInput {
  return {
    ...(f.missingEbm ? missingEbmWhere(orgId) : { orgId }),
    ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.tenantId ? { tenantId: f.tenantId } : {}),
    ...(f.status ? { status: f.status as Invoice['status'] } : {}),
    ...(f.from || f.to ? { issueDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(f.q ? { OR: [{ invoiceNumber: { contains: f.q } }, { ebmReference: { contains: f.q } }, { tenant: { fullName: { contains: f.q } } }, { payment: { receipt: { receiptNumber: { contains: f.q } } } }] } : {}),
  };
}

export async function listInvoices(orgId: string, f: InvoiceFilter, page: { page: number; pageSize: number }) {
  const where = invoiceWhere(orgId, f);
  const [total, items, byStatus, missing] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page.page - 1) * page.pageSize, take: page.pageSize,
      include: {
        tenant: { select: { id: true, fullName: true } }, building: { select: { id: true, name: true } },
        payment: { select: { id: true, status: true, paidAt: true, room: { select: { number: true } }, receipt: { select: { receiptNumber: true } }, method: { select: { name: true } } } },
      },
    }),
    prisma.invoice.groupBy({ by: ['status'], where: { orgId, ...(f.buildingId ? { buildingId: f.buildingId } : {}) }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.invoice.count({ where: missingEbmWhere(orgId, f.buildingId) }),
  ]);
  return { items, total, missingEbm: missing, byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all, amount: money(s._sum.amount) })) };
}
