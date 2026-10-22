import { prisma } from '../db.js';
import type { MessageLog, Prisma } from '../generated/prisma/client.js';
import { badRequest, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { businessDate, longDate, periodLabel } from '../lib/dates.js';
import { formatMoney, sum } from '../lib/money.js';
import { audit } from './audit.js';
import { isEmailConfigured, sendMail } from './mailer.js';
import { isSmsConfigured, sendSms } from './sms.js';
import { getOrg } from './org.js';

export type Template = 'PAYMENT_REMINDER' | 'PAYMENT_CONFIRMATION' | 'CONTRACT_EXPIRY';

/** Which delivery channels are really usable on this server. Nothing is simulated. */
export function channelStatus() {
  return {
    COPY: { available: true, note: 'Copy the text and send it yourself.' },
    EMAIL: { available: isEmailConfigured(), note: isEmailConfigured() ? 'Sent through the configured SMTP server.' : 'SMTP is not configured.' },
    SMS: { available: isSmsConfigured(), note: isSmsConfigured() ? 'Sent through the configured SMS provider.' : 'No SMS provider is configured: use “Open in SMS app” to send from your phone.' },
    WHATSAPP: { available: false, note: 'No WhatsApp provider is configured.' },
  } as const;
}

/** Messages are signed by the company that owns the tenant's building (or the building's name until it has one). */
const signer = (b: { name: string; companyName: string | null }) => b.companyName || b.name;

async function compose(actor: Actor, template: Template, input: { tenantId: string; contractId?: string; paymentId?: string }) {
  const org = await getOrg(actor.orgId);
  const tenant = await prisma.tenant.findFirst({ where: { id: input.tenantId, orgId: actor.orgId } });
  if (!tenant) throw notFound('Tenant');

  if (template === 'PAYMENT_CONFIRMATION') {
    if (!input.paymentId) throw badRequest('Select the payment to confirm.');
    const p = await prisma.payment.findFirst({ where: { id: input.paymentId, orgId: actor.orgId, tenantId: tenant.id }, include: { room: true, receipt: true, method: true, building: { select: { name: true, companyName: true } } } });
    if (!p) throw notFound('Payment');
    const open = await prisma.rentCharge.findMany({ where: { contractId: p.contractId, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, select: { balance: true } });
    return {
      tenant, contractId: p.contractId, subject: `Payment received — ${p.receipt?.receiptNumber ?? ''}`,
      body: `Dear ${tenant.fullName}, we have received your payment of ${formatMoney(p.amount, org.currency)} for Room ${p.room.number} on ${longDate(p.businessDate)} (${p.method.name}). Receipt: ${p.receipt?.receiptNumber ?? '-'}. Remaining balance: ${formatMoney(sum(open.map((c) => c.balance)), org.currency)}. Thank you. — ${signer(p.building)}`,
    };
  }

  const contract = await prisma.contract.findFirst({
    where: { orgId: actor.orgId, tenantId: tenant.id, ...(input.contractId ? { id: input.contractId } : { status: { in: ['ACTIVE', 'EXPIRING', 'EXPIRED'] } }) },
    include: { room: true, building: { select: { name: true, companyName: true } } }, orderBy: { startDate: 'desc' },
  });
  if (!contract) throw badRequest('This tenant has no contract to write about.');

  if (template === 'CONTRACT_EXPIRY') {
    return {
      tenant, contractId: contract.id, subject: `Your rental contract ends on ${longDate(contract.endDate)}`,
      body: `Dear ${tenant.fullName}, your rental contract ${contract.contractNumber} for Room ${contract.room.number} ends on ${longDate(contract.endDate)}. Please contact us to renew it. Thank you. — ${signer(contract.building)}`,
    };
  }

  const all = await prisma.rentCharge.findMany({ where: { contractId: contract.id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, orderBy: { period: 'asc' } });
  if (!all.length) throw badRequest(`${tenant.fullName} has no outstanding rent on contract ${contract.contractNumber}; no reminder is needed.`, 'NOTHING_DUE');
  // Remind about what has fallen due; only if nothing is due yet, about the upcoming month.
  const today = businessDate(org.timezone);
  const due = all.filter((c) => c.dueDate <= today);
  return {
    tenant, contractId: contract.id, subject: `Rent reminder — Room ${contract.room.number}`,
    body: reminderText(tenant.fullName, contract.room.number, due.length ? due : all, today, org.currency, signer(contract.building)),
  };
}

/** The rent reminder for the months in `open` (oldest first). Shared by single messages and the reminder list. */
function reminderText(name: string, room: string, open: Array<{ period: Date; amountDue: Prisma.Decimal; balance: Prisma.Decimal; dueDate: Date; overdueFrom: Date }>, today: Date, currency: string, from: string): string {
  const latest = open[open.length - 1]!;
  const total = sum(open.map((c) => c.balance));
  const months = open.length === 1 ? periodLabel(latest.period) : `${periodLabel(open[0]!.period)} – ${periodLabel(latest.period)}`;
  const overdue = open.some((c) => c.overdueFrom < today);
  return `Dear ${name}, your rent for ${months} for Room ${room} is ${formatMoney(sum(open.map((c) => c.amountDue)), currency)}. Amount outstanding: ${formatMoney(total, currency)}. ${overdue ? 'This payment is overdue; please pay as soon as possible.' : `Please make payment by ${longDate(latest.dueDate)}.`} Thank you. — ${from}`;
}

/**
 * Generates a tenant message from live data. COPY only records that the text was
 * generated; EMAIL actually sends and records SENT or FAILED truthfully.
 */
export async function createMessage(actor: Actor, input: { tenantId: string; contractId?: string; paymentId?: string; template: Template; channel: MessageLog['channel'] }) {
  // Refuse an unavailable channel before doing anything else.
  if (input.channel === 'SMS' && !isSmsConfigured()) throw badRequest('SMS delivery is not configured on this server. Use “Open in SMS app” or copy the message.', 'CHANNEL_UNAVAILABLE');
  if (input.channel === 'EMAIL' && !isEmailConfigured()) throw badRequest('E-mail delivery is not configured on this server. Copy the message instead.', 'CHANNEL_UNAVAILABLE');
  if (input.channel === 'WHATSAPP') throw badRequest('WhatsApp delivery is not configured. Copy the message and send it from your phone.', 'CHANNEL_UNAVAILABLE');
  const { tenant, contractId, subject, body } = await compose(actor, input.template, input);
  let status: MessageLog['status'] = 'GENERATED';
  let error: string | null = null;
  if (input.channel === 'EMAIL') {
    if (!isEmailConfigured()) throw badRequest('E-mail delivery is not configured on this server. Copy the message instead.', 'CHANNEL_UNAVAILABLE');
    if (!tenant.email) throw badRequest(`${tenant.fullName} has no e-mail address on file.`, 'NO_EMAIL');
    const result = await sendMail({ to: tenant.email, subject, text: body });
    status = result.sent ? 'SENT' : 'FAILED';
    error = result.reason ?? null;
  } else if (input.channel === 'SMS') {
    if (!isSmsConfigured()) throw badRequest('SMS delivery is not configured on this server. Use “Open in SMS app” or copy the message.', 'CHANNEL_UNAVAILABLE');
    if (!tenant.phone) throw badRequest(`${tenant.fullName} has no phone number on file.`, 'NO_PHONE');
    const result = await sendSms(tenant.phone, body);
    status = result.sent ? 'SENT' : 'FAILED';
    error = result.reason ?? null;
  } else if (input.channel !== 'COPY') {
    throw badRequest('WhatsApp delivery is not configured. Copy the message and send it from your phone.', 'CHANNEL_UNAVAILABLE');
  }
  const log = await prisma.messageLog.create({ data: { orgId: actor.orgId, tenantId: tenant.id, contractId, channel: input.channel, template: input.template, body, status, error, createdById: actor.userId } });
  await audit(prisma, actor, { action: 'MESSAGE_CREATED', entityType: 'Tenant', entityId: tenant.id, summary: `${input.template.replace(/_/g, ' ').toLowerCase()} ${status === 'SENT' ? `sent by ${input.channel === 'SMS' ? 'SMS' : 'e-mail'} to` : status === 'FAILED' ? `could not be sent by ${input.channel === 'SMS' ? 'SMS' : 'e-mail'} to` : 'generated for'} ${tenant.fullName}` });
  return { id: log.id, subject, body, status, error, channel: input.channel, phone: tenant.phone, email: tenant.email };
}

export async function listMessages(orgId: string, tenantId: string) {
  return prisma.messageLog.findMany({ where: { orgId, tenantId }, orderBy: { createdAt: 'desc' }, take: 100, include: { createdBy: { select: { fullName: true } } } });
}


/**
 * Everyone who still owes rent on a current contract, with the reminder text already written,
 * and when they were last reminded. Nothing is sent or logged by this call.
 */
export async function reminderList(actor: Actor, f: { buildingId?: string; overdueOnly?: boolean }) {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  const charges = await prisma.rentCharge.findMany({
    where: {
      orgId: actor.orgId, balance: { gt: 0 }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, dueDate: { lte: today },
      contract: { status: { in: ['ACTIVE', 'EXPIRING', 'EXPIRED', 'RENEWED'] } },
      ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.overdueOnly ? { overdueFrom: { lt: today } } : {}),
    },
    include: { tenant: { select: { id: true, fullName: true, phone: true } }, room: { select: { number: true } }, building: { select: { name: true, companyName: true } } },
    orderBy: { period: 'asc' },
  });
  const byContract = new Map<string, { contractId: string; tenant: typeof charges[number]['tenant']; room: string; building: string; signer: string; balance: number; months: number; oldestDue: Date; overdue: boolean; open: typeof charges }>();
  for (const c of charges) {
    const row = byContract.get(c.contractId) ?? { contractId: c.contractId, tenant: c.tenant, room: c.room.number, building: c.building.name, signer: signer(c.building), balance: 0, months: 0, oldestDue: c.dueDate, overdue: false, open: [] };
    row.open.push(c);
    row.balance += Number(c.balance);
    row.months += 1;
    row.overdue ||= c.overdueFrom < today;
    byContract.set(c.contractId, row);
  }
  const rows = [...byContract.values()];
  const last = await prisma.messageLog.groupBy({ by: ['contractId'], where: { orgId: actor.orgId, template: 'PAYMENT_REMINDER', contractId: { not: null } }, _max: { createdAt: true } });
  const lastAt = new Map(last.map((l) => [l.contractId, l._max.createdAt]));
  // Messages are written from the charges already loaded — the same text as a single reminder, without a lookup per tenant.
  const items = rows.map((r) => ({
    contractId: r.contractId, tenantId: r.tenant.id, fullName: r.tenant.fullName, phone: r.tenant.phone, room: r.room, building: r.building,
    balance: r.balance, months: r.months, oldestDue: r.oldestDue, overdue: r.overdue, lastRemindedAt: lastAt.get(r.contractId) ?? null,
    message: reminderText(r.tenant.fullName, r.room, r.open, today, org.currency, r.signer),
  }));
  return { items: items.sort((a, b) => b.balance - a.balance), smsConfigured: isSmsConfigured() };
}

/** Sends the reminder by SMS to each selected contract's tenant, one by one; every result is logged truthfully. */
export async function sendReminders(actor: Actor, contractIds: string[]) {
  if (!isSmsConfigured()) throw badRequest('SMS delivery is not configured on this server.', 'CHANNEL_UNAVAILABLE');
  const results = [];
  for (const contractId of contractIds) {
    const contract = await prisma.contract.findFirst({ where: { id: contractId, orgId: actor.orgId }, select: { tenantId: true } });
    if (!contract) continue;
    try {
      const r = await createMessage(actor, { tenantId: contract.tenantId, contractId, template: 'PAYMENT_REMINDER', channel: 'SMS' });
      results.push({ contractId, status: r.status, error: r.error });
    } catch (err) {
      results.push({ contractId, status: 'FAILED' as const, error: err instanceof Error ? err.message : 'Failed' });
    }
  }
  return { sent: results.filter((r) => r.status === 'SENT').length, failed: results.filter((r) => r.status !== 'SENT').length, results };
}
