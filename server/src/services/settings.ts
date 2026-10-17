import { inTransaction, prisma } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { audit, diff } from './audit.js';
import { getOrg } from './org.js';

export interface OrgSettings {
  name?: string;
  legalName?: string | null;
  tin?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  defaultDueDay?: number;
  defaultGraceDays?: number;
  expiringSoonDays?: number;
  dueSoonDays?: number;
  receiptPrefix?: string;
  invoicePrefix?: string;
  contractPrefix?: string;
  notifyInApp?: boolean;
  proratePartialMonths?: boolean;
  requirePaymentVerification?: boolean;
}

export async function updateOrganization(actor: Actor, input: OrgSettings) {
  return inTransaction(async (tx) => {
    const before = await getOrg(actor.orgId, tx);
    const org = await tx.organization.update({ where: { id: actor.orgId }, data: input });
    // Switching verification off settles the payments still waiting for it: they count as verified by whoever made the change.
    if (before.requirePaymentVerification && input.requirePaymentVerification === false) {
      const waiting = await tx.payment.updateMany({ where: { orgId: actor.orgId, type: 'PAYMENT', status: 'POSTED', verifiedAt: null }, data: { verifiedById: actor.userId, verifiedAt: new Date() } });
      if (waiting.count) await audit(tx, actor, { action: 'PAYMENT_VERIFIED', entityType: 'Organization', entityId: org.id, summary: `${waiting.count} payment(s) awaiting verification marked verified when payment verification was switched off` });
    }
    const d = diff(before, org);
    if (d) await audit(tx, actor, { action: 'SETTINGS_CHANGED', entityType: 'Organization', entityId: org.id, summary: `Organization settings changed: ${Object.keys(d.new).join(', ')}`, oldValue: d.old, newValue: d.new });
    return org;
  });
}

export const listCategories = (orgId: string) => prisma.expenseCategory.findMany({ where: { orgId }, orderBy: { name: 'asc' } });
export const listMethods = (orgId: string) => prisma.paymentMethod.findMany({ where: { orgId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });

export async function saveCategory(actor: Actor, input: { id?: string; name?: string; isActive?: boolean }) {
  return inTransaction(async (tx) => {
    if (input.id) {
      const before = await tx.expenseCategory.findFirst({ where: { id: input.id, orgId: actor.orgId } });
      if (!before) throw notFound('Expense category');
      const cat = await tx.expenseCategory.update({ where: { id: input.id }, data: { name: input.name, isActive: input.isActive } });
      await audit(tx, actor, { action: 'EXPENSE_CATEGORY_CHANGED', entityType: 'ExpenseCategory', entityId: cat.id, summary: `Expense category ${cat.name} updated`, oldValue: before, newValue: cat });
      return cat;
    }
    if (!input.name?.trim()) throw badRequest('Enter a category name.');
    const cat = await tx.expenseCategory.create({ data: { orgId: actor.orgId, name: input.name.trim() } });
    await audit(tx, actor, { action: 'EXPENSE_CATEGORY_CHANGED', entityType: 'ExpenseCategory', entityId: cat.id, summary: `Expense category ${cat.name} added` });
    return cat;
  });
}

export async function saveMethod(actor: Actor, input: { id?: string; code?: string; name?: string; requiresReference?: boolean; isActive?: boolean }) {
  return inTransaction(async (tx) => {
    if (input.id) {
      const before = await tx.paymentMethod.findFirst({ where: { id: input.id, orgId: actor.orgId } });
      if (!before) throw notFound('Payment method');
      if (input.isActive === false) {
        const active = await tx.paymentMethod.count({ where: { orgId: actor.orgId, isActive: true, id: { not: input.id } } });
        if (active === 0) throw conflict('At least one payment method must stay active.');
      }
      // The code is a stable identifier used in history; only the label and behaviour can change.
      const method = await tx.paymentMethod.update({ where: { id: input.id }, data: { name: input.name, requiresReference: input.requiresReference, isActive: input.isActive } });
      await audit(tx, actor, { action: 'PAYMENT_METHOD_CHANGED', entityType: 'PaymentMethod', entityId: method.id, summary: `Payment method ${method.name} updated`, oldValue: before, newValue: method });
      return method;
    }
    if (!input.name?.trim()) throw badRequest('Enter a name for the payment method.');
    const code = (input.code ?? input.name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!code) throw badRequest('Enter a code for the payment method.');
    const max = await tx.paymentMethod.aggregate({ where: { orgId: actor.orgId }, _max: { sortOrder: true } });
    const method = await tx.paymentMethod.create({ data: { orgId: actor.orgId, code, name: input.name.trim(), requiresReference: input.requiresReference ?? false, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
    await audit(tx, actor, { action: 'PAYMENT_METHOD_CHANGED', entityType: 'PaymentMethod', entityId: method.id, summary: `Payment method ${method.name} added` });
    return method;
  });
}

export const DEFAULT_EXPENSE_CATEGORIES = ['Maintenance', 'Cleaning', 'Electricity', 'Water', 'Security', 'Salaries', 'Taxes', 'Repairs', 'Supplies', 'Transport', 'Other'];
export const DEFAULT_PAYMENT_METHODS = [
  { code: 'CASH', name: 'Cash', requiresReference: false },
  { code: 'BANK', name: 'Bank', requiresReference: true },
  { code: 'MOBILE_MONEY', name: 'Mobile Money', requiresReference: true },
  { code: 'AIRTEL_MONEY', name: 'Airtel Money', requiresReference: true },
  { code: 'OTHER', name: 'Other', requiresReference: false },
];

/** Creates the default categories and payment methods of a new organization (idempotent). */
export async function ensureDefaults(orgId: string): Promise<void> {
  await prisma.expenseCategory.createMany({ data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ orgId, name })), skipDuplicates: true });
  await prisma.paymentMethod.createMany({ data: DEFAULT_PAYMENT_METHODS.map((m, i) => ({ orgId, ...m, sortOrder: i })), skipDuplicates: true });
}
