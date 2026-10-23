import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { actorOf, can } from '../http/context.js';
import { requirePermission } from '../http/middleware.js';
import { paged, zDate, zId, zOptionalDate, zOptionalId, zPage, zPositiveMoney, zRequiredText, zText } from '../http/validation.js';
import { businessDate, endOfMonth, isoDate, periodLabel, startOfMonth } from '../lib/dates.js';
import { formatMoney } from '../lib/money.js';
import * as approvals from '../services/approvals.js';
import * as deposits from '../services/deposits.js';
import * as expenses from '../services/expenses.js';
import { templateLogo } from '../services/contractDocument.js';
import { receiptToPdf, reportToExcel, reportToPdf, type ReceiptData } from '../services/exporters.js';
import * as invoices from '../services/invoices.js';
import * as messages from '../services/messages.js';
import { notifyPermission, notifyUsers } from '../services/notifications.js';
import { getOrg } from '../services/org.js';
import * as payments from '../services/payments.js';
import * as periods from '../services/periods.js';
import { generateReport, REPORT_TYPES, type ReportParams, type ReportType } from '../services/reports.js';
import { runDailyJobs } from '../services/scheduler.js';
import { rentLedger } from '../services/tenants.js';

export const financeRouter = Router();

const zBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

// ───────────── Rent ledger ─────────────

financeRouter.get('/rent/charges', requirePermission('rent.view'), async (req, res) => {
  const q = zPage.extend({
    tenantId: zOptionalId, contractId: zOptionalId, roomId: zOptionalId, buildingId: zOptionalId, floorId: zOptionalId, status: zText(20),
    from: zOptionalDate, to: zOptionalDate, overdueOnly: zBool, owingOnly: zBool, includeVoid: zBool,
  }).parse(req.query);
  const r = await rentLedger(actorOf(req).orgId, q, q, req.query.dir === 'asc' ? 'asc' : 'desc');
  res.json({ ...paged(r.items, r.total, q), totals: r.totals });
});

financeRouter.post('/rent/generate', requirePermission('rent.generate'), async (req, res) => {
  res.json(await runDailyJobs(actorOf(req).orgId));
});

financeRouter.post('/rent/charges/:id/waive', requirePermission('adjustment.request'), async (req, res) => {
  const actor = actorOf(req);
  const body = z.object({ amount: zPositiveMoney, reason: zRequiredText(500, 'Reason') }).parse(req.body);
  const charge = await prisma.rentCharge.findFirst({ where: { id: zId.parse(req.params.id), orgId: actor.orgId }, include: { tenant: true, room: true } });
  if (!charge) throw notFound('Rent charge');
  const result = await approvals.submitApproval(actor, {
    type: 'DEBT_WAIVER', entityType: 'RentCharge', entityId: charge.id, reason: body.reason, payload: { chargeId: charge.id, amount: body.amount.toFixed(2) },
    summary: `Waive ${formatMoney(body.amount)} of ${periodLabel(charge.period)} rent — ${charge.tenant.fullName}, room ${charge.room.number}`,
  });
  if (!result.executed) await notifyPermission(prisma, actor.orgId, 'approval.decide', { category: 'FINANCE', title: 'Debt waiver awaiting approval', body: result.approval.summary, entityType: 'Approval', entityId: result.approval.id, dedupeKey: `approval:${result.approval.id}` });
  res.status(201).json(result);
});

// ───────────── Payments ─────────────

const zPaidAt = z.preprocess((v) => (v === '' ? undefined : v), z.string().datetime({ offset: true, message: 'Invalid payment date/time.' }).optional()).transform((s) => (s ? new Date(s) : undefined));

financeRouter.get('/payments', requirePermission('payment.view'), async (req, res) => {
  const q = zPage.extend({
    buildingId: zOptionalId, floorId: zOptionalId, roomId: zOptionalId, tenantId: zOptionalId, contractId: zOptionalId, methodId: zOptionalId,
    from: zOptionalDate, to: zOptionalDate, status: z.enum(['POSTED', 'REVERSED']).optional().or(z.literal('').transform(() => undefined)),
    type: z.enum(['PAYMENT', 'REVERSAL']).optional().or(z.literal('').transform(() => undefined)), verified: zBool,
  }).parse(req.query);
  const r = await payments.listPayments(actorOf(req).orgId, q, q);
  res.json({ ...paged(r.items, r.total, q), netAmount: r.netAmount });
});

financeRouter.post('/payments/preview', requirePermission('payment.create'), async (req, res) => {
  const body = z.object({ contractId: zId, amount: zPositiveMoney, overpayment: z.enum(['REJECT', 'ADVANCE']).optional() }).parse(req.body);
  res.json(await payments.previewPayment(actorOf(req), body));
});

financeRouter.post('/payments', requirePermission('payment.create'), async (req, res) => {
  const actor = actorOf(req);
  const body = z.object({
    contractId: zId, amount: zPositiveMoney, methodId: zId, reference: zText(80), paidAt: zPaidAt, notes: zText(2000), overpayment: z.enum(['REJECT', 'ADVANCE']).optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, 'A submission key is required.'),
  }).parse(req.body);
  // The key may also arrive as a header; the body value is authoritative.
  const result = await payments.recordPayment(actor, body);
  const detail = await payments.paymentDetail(actor.orgId, result.paymentId);
  if (!result.replayed && !detail.verifiedAt) {
    await notifyPermission(prisma, actor.orgId, 'payment.verify', {
      category: 'PAYMENT', title: `Payment recorded — ${detail.receipt?.receiptNumber ?? ''}`, entityType: 'Payment', entityId: detail.id, dedupeKey: `payment:${detail.id}`,
      body: `${formatMoney(detail.amount)} from ${detail.tenant.fullName} (room ${detail.room.number}, ${detail.method.name}) recorded by ${actor.name}. Awaiting verification.`,
    }, actor.userId);
  }
  res.status(result.replayed ? 200 : 201).json({ ...detail, replayed: result.replayed });
});

financeRouter.get('/payments/:id', requirePermission('payment.view'), async (req, res) => {
  res.json(await payments.paymentDetail(actorOf(req).orgId, zId.parse(req.params.id)));
});

financeRouter.post('/payments/:id/verify', requirePermission('payment.verify'), async (req, res) => {
  res.json(await payments.verifyPayment(actorOf(req), zId.parse(req.params.id)));
});

financeRouter.post('/payments/:id/reverse', requirePermission('payment.reverse.request'), async (req, res) => {
  const actor = actorOf(req);
  const body = z.object({ reason: zRequiredText(500, 'Reason') }).parse(req.body);
  const payment = await payments.paymentDetail(actor.orgId, zId.parse(req.params.id));
  const result = await approvals.submitApproval(actor, {
    type: 'PAYMENT_REVERSAL', entityType: 'Payment', entityId: payment.id, reason: body.reason, payload: {},
    summary: `Reverse payment ${payment.receipt?.receiptNumber ?? ''} of ${formatMoney(payment.amount)} — ${payment.tenant.fullName}, room ${payment.room.number}`,
  });
  if (!result.executed) await notifyPermission(prisma, actor.orgId, 'approval.decide', { category: 'FINANCE', title: 'Payment reversal awaiting approval', body: result.approval.summary, entityType: 'Approval', entityId: result.approval.id, dedupeKey: `approval:${result.approval.id}` });
  res.status(201).json(result);
});

financeRouter.get('/payments/:id/receipt.pdf', requirePermission('payment.view'), async (req, res) => {
  const actor = actorOf(req);
  const payment = await prisma.payment.findFirst({ where: { id: zId.parse(req.params.id), orgId: actor.orgId }, include: { receipt: true, invoice: true } });
  if (!payment?.receipt) throw notFound('Receipt');
  const org = await getOrg(actor.orgId);
  // The receipt carries the logo of the tenant's building: the one printed on that building's lease contract.
  const building = await prisma.building.findUnique({ where: { id: payment.buildingId }, select: { contractTemplate: true } });
  const pdf = await receiptToPdf(payment.receipt.snapshot as unknown as ReceiptData, {
    voided: Boolean(payment.receipt.voidedAt), voidReason: payment.receipt.voidReason, ebmReference: payment.invoice?.ebmReference, isDemoData: org.isDemo,
    logo: await templateLogo(building?.contractTemplate),
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${payment.receipt.receiptNumber}.pdf"`);
  res.send(pdf);
});

// ───────────── Security deposits ─────────────

financeRouter.get('/deposits', requirePermission('deposit.view'), async (req, res) => {
  const q = z.object({ buildingId: zOptionalId, onlyHeld: zBool }).parse(req.query);
  res.json({ items: await deposits.listDeposits(actorOf(req).orgId, q) });
});
financeRouter.post('/contracts/:id/deposits', requirePermission('deposit.manage'), async (req, res) => {
  const body = z.object({ amount: zPositiveMoney, txnDate: zOptionalDate, methodId: zId, reference: zText(80) }).parse(req.body);
  res.status(201).json(await deposits.recordDepositPayment(actorOf(req), { contractId: zId.parse(req.params.id), ...body }));
});
financeRouter.post('/contracts/:id/deposits/deduction', requirePermission('deposit.manage'), async (req, res) => {
  const body = z.object({ amount: zPositiveMoney, reason: zRequiredText(255, 'Reason') }).parse(req.body);
  res.status(201).json(await deposits.recordDepositDeduction(actorOf(req), { contractId: zId.parse(req.params.id), ...body }));
});
financeRouter.post('/contracts/:id/deposits/refund', requirePermission('deposit.manage'), async (req, res) => {
  const actor = actorOf(req);
  const body = z.object({ amount: zPositiveMoney, methodId: zOptionalId, reference: zText(80), reason: zRequiredText(255, 'Reason') }).parse(req.body);
  const contract = await prisma.contract.findFirst({ where: { id: zId.parse(req.params.id), orgId: actor.orgId }, include: { tenant: true, room: true } });
  if (!contract) throw notFound('Contract');
  const result = await approvals.submitApproval(actor, {
    type: 'DEPOSIT_REFUND', entityType: 'Contract', entityId: contract.id, reason: body.reason, payload: { amount: body.amount.toFixed(2), methodId: body.methodId ?? null, reference: body.reference ?? null },
    summary: `Refund deposit ${formatMoney(body.amount)} — ${contract.tenant.fullName}, room ${contract.room.number}`,
  });
  if (!result.executed) await notifyPermission(prisma, actor.orgId, 'approval.decide', { category: 'FINANCE', title: 'Deposit refund awaiting approval', body: result.approval.summary, entityType: 'Approval', entityId: result.approval.id, dedupeKey: `approval:${result.approval.id}` });
  res.status(201).json(result);
});

// Rent discount / surcharge (always through the approval workflow).
financeRouter.post('/contracts/:id/adjustments', requirePermission('adjustment.request'), async (req, res) => {
  const actor = actorOf(req);
  const body = z.object({ type: z.enum(['DISCOUNT', 'SURCHARGE']), amount: zPositiveMoney, effectiveFrom: zDate, effectiveTo: zOptionalDate, reason: zRequiredText(500, 'Reason') }).parse(req.body);
  const contract = await prisma.contract.findFirst({ where: { id: zId.parse(req.params.id), orgId: actor.orgId }, include: { tenant: true, room: true } });
  if (!contract) throw notFound('Contract');
  const result = await approvals.submitApproval(actor, {
    type: 'RENT_ADJUSTMENT', entityType: 'Contract', entityId: contract.id, reason: body.reason,
    payload: { type: body.type, amount: body.amount.toFixed(2), effectiveFrom: isoDate(body.effectiveFrom), effectiveTo: body.effectiveTo ? isoDate(body.effectiveTo) : null },
    summary: `${body.type === 'DISCOUNT' ? 'Discount' : 'Surcharge'} of ${formatMoney(body.amount)}/month from ${isoDate(body.effectiveFrom)}${body.effectiveTo ? ` to ${isoDate(body.effectiveTo)}` : ''} — ${contract.tenant.fullName}, room ${contract.room.number}`,
  });
  if (!result.executed) await notifyPermission(prisma, actor.orgId, 'approval.decide', { category: 'FINANCE', title: 'Rent adjustment awaiting approval', body: result.approval.summary, entityType: 'Approval', entityId: result.approval.id, dedupeKey: `approval:${result.approval.id}` });
  res.status(201).json(result);
});

// ───────────── Approvals ─────────────

financeRouter.get('/approvals', requirePermission('approval.view', 'approval.decide'), async (req, res) => {
  const q = zPage.extend({ status: zText(20), type: zText(30) }).parse(req.query);
  const r = await approvals.listApprovals(actorOf(req).orgId, q, q);
  res.json(paged(r.items, r.total, q));
});
financeRouter.post('/approvals/:id/decision', requirePermission('approval.decide'), async (req, res) => {
  const actor = actorOf(req);
  const body = z.object({ approve: z.boolean(), note: zText(500) }).parse(req.body);
  const decided = await approvals.decideApproval(actor, zId.parse(req.params.id), body.approve, body.note);
  await notifyUsers(prisma, [decided.requestedById], { category: 'FINANCE', title: `Request ${body.approve ? 'approved' : 'rejected'}`, body: `${decided.summary}${body.note ? ` — ${body.note}` : ''}`, entityType: 'Approval', entityId: decided.id, dedupeKey: `approval-decision:${decided.id}` });
  res.json(decided);
});
financeRouter.post('/approvals/:id/cancel', requirePermission('approval.view', 'approval.decide'), async (req, res) => {
  res.json(await approvals.cancelApproval(actorOf(req), zId.parse(req.params.id)));
});

// ───────────── Invoices / EBM ─────────────

financeRouter.get('/invoices', requirePermission('invoice.view'), async (req, res) => {
  const q = zPage.extend({ buildingId: zOptionalId, tenantId: zOptionalId, status: zText(20), missingEbm: zBool, from: zOptionalDate, to: zOptionalDate }).parse(req.query);
  const r = await invoices.listInvoices(actorOf(req).orgId, q, q);
  res.json({ ...paged(r.items, r.total, q), missingEbm: r.missingEbm, byStatus: r.byStatus });
});
financeRouter.patch('/invoices/:id', requirePermission('invoice.manage'), async (req, res) => {
  const body = z.object({
    status: z.enum(['PENDING', 'GENERATED', 'ISSUED', 'FAILED', 'CANCELLED']).optional(),
    ebmReference: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(80).nullable().optional()), statusNote: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(255).nullable().optional()),
  }).parse(req.body);
  res.json(await invoices.updateInvoice(actorOf(req), zId.parse(req.params.id), body));
});

// ───────────── Expenses ─────────────

const zExpense = z.object({
  scope: z.enum(['ORGANIZATION', 'BUILDING', 'FLOOR', 'ROOM']), buildingId: zOptionalId, floorId: zOptionalId, roomId: zOptionalId, categoryId: zId,
  description: zRequiredText(500, 'Description'), amount: zPositiveMoney, expenseDate: zDate, methodId: zOptionalId, supplier: zText(160), reference: zText(80),
  maintenanceRequestId: zOptionalId, draft: z.boolean().optional(),
});

financeRouter.get('/expenses', requirePermission('expense.view'), async (req, res) => {
  const q = zPage.extend({ buildingId: zOptionalId, floorId: zOptionalId, roomId: zOptionalId, categoryId: zOptionalId, status: zText(20), scope: zText(20), from: zOptionalDate, to: zOptionalDate, maintenanceRequestId: zOptionalId }).parse(req.query);
  const r = await expenses.listExpenses(actorOf(req).orgId, q, q);
  res.json({ ...paged(r.items, r.total, q), approvedTotal: r.approvedTotal });
});
financeRouter.post('/expenses', requirePermission('expense.create'), async (req, res) => {
  const actor = actorOf(req);
  const expense = await expenses.createExpense(actor, zExpense.parse(req.body));
  if (expense.status === 'SUBMITTED') await notifyPermission(prisma, actor.orgId, 'expense.approve', { category: 'FINANCE', title: 'Expense awaiting approval', body: `${expense.number}: ${formatMoney(expense.amount)} — ${expense.description}`, entityType: 'Expense', entityId: expense.id, dedupeKey: `expense:${expense.id}` }, actor.userId);
  res.status(201).json(expense);
});
financeRouter.get('/expenses/:id', requirePermission('expense.view'), async (req, res) => {
  res.json(await expenses.expenseDetail(actorOf(req).orgId, zId.parse(req.params.id)));
});
financeRouter.patch('/expenses/:id', requirePermission('expense.create'), async (req, res) => {
  res.json(await expenses.updateExpense(actorOf(req), zId.parse(req.params.id), zExpense.partial().parse(req.body)));
});
financeRouter.post('/expenses/:id/decision', requirePermission('expense.approve'), async (req, res) => {
  const body = z.object({ decision: z.enum(['APPROVED', 'REJECTED', 'VOID']), note: zText(255) }).parse(req.body);
  const expense = await expenses.decideExpense(actorOf(req), zId.parse(req.params.id), body.decision, body.note);
  await notifyUsers(prisma, [expense.recordedById], { category: 'FINANCE', title: `Expense ${body.decision.toLowerCase()}`, body: `${expense.number}: ${formatMoney(expense.amount)}${body.note ? ` — ${body.note}` : ''}`, entityType: 'Expense', entityId: expense.id, dedupeKey: `expense-${body.decision}:${expense.id}` });
  res.json(expense);
});

// ───────────── Accounting periods ─────────────

financeRouter.get('/periods', requirePermission('report.financial', 'period.manage'), async (req, res) => {
  res.json({ items: await periods.listPeriods(actorOf(req).orgId) });
});
financeRouter.post('/periods/close', requirePermission('period.manage'), async (req, res) => {
  const body = z.object({ period: zDate, note: zText(255) }).parse(req.body);
  res.status(201).json(await periods.closePeriod(actorOf(req), body.period, body.note));
});
financeRouter.post('/periods/:id/reopen', requirePermission('period.manage'), async (req, res) => {
  const body = z.object({ reason: zRequiredText(200, 'Reason') }).parse(req.body);
  res.json(await periods.reopenPeriod(actorOf(req), zId.parse(req.params.id), body.reason));
});

// ───────────── Tenant messages ─────────────

financeRouter.post('/messages', requirePermission('message.create'), async (req, res) => {
  const body = z.object({ tenantId: zId, contractId: zOptionalId, paymentId: zOptionalId, template: z.enum(['PAYMENT_REMINDER', 'PAYMENT_CONFIRMATION', 'CONTRACT_EXPIRY']), channel: z.enum(['COPY', 'EMAIL', 'SMS', 'WHATSAPP']).default('COPY') }).parse(req.body);
  res.status(201).json(await messages.createMessage(actorOf(req), body));
});
financeRouter.get('/messages/reminders', requirePermission('message.create'), async (req, res) => {
  const q = z.object({ buildingId: zOptionalId, overdueOnly: zBool }).parse(req.query);
  res.json(await messages.reminderList(actorOf(req), q));
});
financeRouter.post('/messages/reminders/send', requirePermission('message.create'), async (req, res) => {
  const body = z.object({ contractIds: z.array(zId).min(1).max(500) }).parse(req.body);
  res.json(await messages.sendReminders(actorOf(req), body.contractIds));
});
financeRouter.get('/tenants/:id/messages', requirePermission('tenant.view'), async (req, res) => {
  res.json({ items: await messages.listMessages(actorOf(req).orgId, zId.parse(req.params.id)) });
});

// ───────────── Reports ─────────────

const zReportQuery = z.object({
  from: zOptionalDate, to: zOptionalDate, buildingId: zOptionalId, floorId: zOptionalId, roomId: zOptionalId, tenantId: zOptionalId, methodId: zOptionalId,
  paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED', 'VOID']).optional().or(z.literal('').transform(() => undefined)),
  contractStatus: z.enum(['DRAFT', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'TERMINATED', 'RENEWED']).optional().or(z.literal('').transform(() => undefined)),
  groupBy: z.enum(['floor', 'room']).optional().or(z.literal('').transform(() => undefined)), sort: zText(20), overdueOnly: zBool,
});

async function reportParams(req: Parameters<Parameters<typeof financeRouter.get>[1]>[0]): Promise<{ type: ReportType; params: ReportParams }> {
  const actor = actorOf(req);
  const type = String(req.params.type) as ReportType;
  if (!(type in REPORT_TYPES)) throw notFound('Report');
  // Financial reports need the financial-report permission; operational ones the general one.
  if (!can(actor, REPORT_TYPES[type].financial ? 'report.financial' : 'report.view')) throw forbidden('You do not have permission to view this report.');
  const q = zReportQuery.parse(req.query);
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  const from = q.from ?? (type === 'daily-collection' ? today : startOfMonth(today));
  const to = q.to ?? (type === 'daily-collection' ? from : endOfMonth(from));
  return { type, params: { ...q, from, to } };
}

financeRouter.get('/reports', requirePermission('report.view', 'report.financial'), (req, res) => {
  const actor = actorOf(req);
  res.json({ items: Object.entries(REPORT_TYPES).filter(([, d]) => can(actor, d.financial ? 'report.financial' : 'report.view')).map(([type, d]) => ({ type, ...d })), canExport: can(actor, 'export.data') });
});

financeRouter.get('/reports/:type', requirePermission('report.view', 'report.financial'), async (req, res) => {
  const { type, params } = await reportParams(req);
  res.json(await generateReport(actorOf(req), type, params, 'screen'));
});

financeRouter.get('/reports/:type/export', requirePermission('export.data'), async (req, res) => {
  const { type, params } = await reportParams(req);
  const format = z.enum(['pdf', 'xlsx']).parse(req.query.format);
  const report = await generateReport(actorOf(req), type, params, format);
  const name = `${type}-${isoDate(params.from)}_${isoDate(params.to)}.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.send(await reportToPdf(report));
  } else {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(await reportToExcel(report));
  }
});

