import { prisma } from '../db.js';
import { can, type Actor } from '../http/context.js';
import { isoDate } from '../lib/dates.js';
import { formatMoney } from '../lib/money.js';
import { formatPhone, phoneSearchDigits } from '../lib/phone.js';

export interface SearchHit {
  type: 'tenant' | 'room' | 'building' | 'contract' | 'payment';
  id: string;
  title: string;
  /** Where this record sits, so two similar hits can be told apart. */
  context: string;
  badge?: string;
  href: string;
}

/** Global search. Each result type is only searched if the user may view that kind of record. */
export async function globalSearch(actor: Actor, q: string): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const take = 6;
  const orgId = actor.orgId;
  const [tenants, rooms, buildings, contracts, payments] = await Promise.all([
    can(actor, 'tenant.view')
      ? prisma.tenant.findMany({
          where: { orgId, OR: [{ fullName: { contains: term } }, { phone: { contains: phoneSearchDigits(term) ?? term } }, { idNumber: { contains: term } }, { businessName: { contains: term } }] }, take, orderBy: { fullName: 'asc' },
          include: { contracts: { where: { status: { in: ['ACTIVE', 'EXPIRING', 'EXPIRED'] } }, select: { room: { select: { number: true } }, building: { select: { name: true } } } } },
        })
      : [],
    can(actor, 'room.view')
      ? prisma.room.findMany({
          where: { building: { orgId }, number: { contains: term } }, take, orderBy: { number: 'asc' },
          include: { building: { select: { name: true } }, floor: { select: { name: true } }, contracts: { where: { status: { in: ['ACTIVE', 'EXPIRING', 'EXPIRED'] } }, select: { tenant: { select: { fullName: true } } } } },
        })
      : [],
    can(actor, 'building.view') ? prisma.building.findMany({ where: { orgId, OR: [{ name: { contains: term } }, { code: { contains: term } }] }, take }) : [],
    can(actor, 'contract.view')
      ? prisma.contract.findMany({ where: { orgId, contractNumber: { contains: term } }, take, orderBy: { createdAt: 'desc' }, include: { tenant: { select: { fullName: true } }, room: { select: { number: true } }, building: { select: { name: true } } } })
      : [],
    // Receipt numbers and payment references always contain digits; looking them up separately (receipts, then
    // references) keeps the search fast with hundreds of thousands of payments.
    can(actor, 'payment.view') && /\d/.test(term) && term.length >= 3
      ? (async () => {
          const [byReceipt, byReference] = await Promise.all([
            prisma.receipt.findMany({ where: { orgId, receiptNumber: { contains: term } }, take, select: { paymentId: true }, orderBy: { issuedAt: 'desc' } }),
            prisma.payment.findMany({ where: { orgId, type: 'PAYMENT', reference: { contains: term } }, take, select: { id: true }, orderBy: { paidAt: 'desc' } }),
          ]);
          const ids = [...new Set([...byReceipt.map((r) => r.paymentId), ...byReference.map((p) => p.id)])].slice(0, take);
          return prisma.payment.findMany({
            where: { id: { in: ids }, type: 'PAYMENT' }, orderBy: { paidAt: 'desc' },
            include: { tenant: { select: { fullName: true } }, room: { select: { number: true } }, building: { select: { name: true } }, receipt: { select: { receiptNumber: true } }, method: { select: { name: true } } },
          });
        })()
      : [],
  ]);
  return [
    ...tenants.map((t): SearchHit => ({
      type: 'tenant', id: t.id, title: t.fullName, badge: t.status, href: `/tenants/${t.id}`,
      context: [formatPhone(t.phone), `ID ${t.idNumber}`, t.contracts.length ? t.contracts.map((c) => `Room ${c.room.number}, ${c.building.name}`).join('; ') : 'No current room'].join(' · '),
    })),
    ...rooms.map((r): SearchHit => ({ type: 'room', id: r.id, title: `Room ${r.number}`, badge: r.status, href: `/rooms/${r.id}`, context: [r.building.name, r.floor.name, r.contracts[0]?.tenant.fullName ?? 'No tenant'].join(' · ') })),
    ...buildings.map((b): SearchHit => ({ type: 'building', id: b.id, title: b.name, badge: b.status, href: `/buildings?selected=${b.id}`, context: `Building code ${b.code}` })),
    ...contracts.map((c): SearchHit => ({ type: 'contract', id: c.id, title: c.contractNumber, badge: c.status, href: `/contracts/${c.id}`, context: [c.tenant.fullName, `Room ${c.room.number}`, c.building.name, `${isoDate(c.startDate)} – ${isoDate(c.endDate)}`].join(' · ') })),
    ...payments.map((p): SearchHit => ({ type: 'payment', id: p.id, title: p.receipt?.receiptNumber ?? 'Payment', badge: p.status, href: `/payments/${p.id}`, context: [formatMoney(p.amount), p.tenant.fullName, `Room ${p.room.number}`, p.building.name, p.method.name, p.reference ? `ref ${p.reference}` : '', isoDate(p.businessDate)].filter(Boolean).join(' · ') })),
  ];
}
