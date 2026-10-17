/**
 * DEMO / DEVELOPMENT seed. Creates clearly-labelled sample data through the same
 * services the application uses, so every business rule is exercised.
 *
 *   npm run db:seed              → seeds an EMPTY database
 *   npm run db:seed -- --reset   → wipes a DEMO database and seeds again
 *
 * It refuses to run in production and refuses to touch a database that holds
 * non-demo data. The organization is flagged isDemo, which puts a "DEMO DATA"
 * banner on every screen, report and receipt.
 */
import { SYSTEM_ROLES } from '../src/auth/permissions.js';
import { hashPassword } from '../src/auth/passwords.js';
import { prisma } from '../src/db.js';
import type { Actor } from '../src/http/context.js';
import { addDays, addMonths, businessDate, endOfMonth, isoDate, startOfMonth } from '../src/lib/dates.js';
import { Decimal } from '../src/lib/money.js';
import { decideApproval, submitApproval } from '../src/services/approvals.js';
import { createContract, renewContract } from '../src/services/contracts.js';
import { recordDepositPayment } from '../src/services/deposits.js';
import { createExpense, decideExpense } from '../src/services/expenses.js';
import { updateInvoice } from '../src/services/invoices.js';
import { createMaintenance, updateMaintenance } from '../src/services/maintenance.js';
import { recordPayment, verifyPayment } from '../src/services/payments.js';
import { closePeriod } from '../src/services/periods.js';
import { createBuilding, createFloor, createReservation, createRoom } from '../src/services/property.js';
import { syncRbac } from '../src/services/rbac.js';
import { runDailyJobs } from '../src/services/scheduler.js';
import { ensureDefaults } from '../src/services/settings.js';
import { createTenant } from '../src/services/tenants.js';
import { wipeAllTables } from './wipe.js';

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Demo@Pass2026';
const TZ = 'Africa/Kigali';

// Deterministic pseudo-random numbers so every seed run produces the same data.
let state = 20261001;
const rand = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;

const FIRST = ['Jean', 'Marie', 'Eric', 'Claudine', 'Patrick', 'Aline', 'Emmanuel', 'Diane', 'Olivier', 'Chantal', 'Innocent', 'Josiane', 'Fabrice', 'Vestine', 'Theogene', 'Immaculee', 'Didier', 'Solange', 'Pacifique', 'Esperance', 'Gilbert', 'Jeannette', 'Aimable', 'Beatrice', 'Celestin'];
const LAST = ['Mugisha', 'Uwimana', 'Habimana', 'Mukamana', 'Niyonzima', 'Ingabire', 'Ndayisaba', 'Umutoni', 'Hakizimana', 'Uwase', 'Nsengiyumva', 'Mukeshimana', 'Bizimana', 'Nyirahabimana', 'Rukundo', 'Kayitesi', 'Gasana', 'Murekatete', 'Twagirayezu', 'Umuhoza'];
const BUSINESS = ['Boutique', 'Electronics', 'Pharmacy', 'Tailoring', 'Hardware', 'Salon', 'Stationery', 'Phone Repair', 'Forex Bureau', 'Cosmetics', 'Wholesale', 'Travel Agency', 'Print Shop', 'Bookshop', 'Consultancy'];

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The demo seed must never run in production. Use "npm run bootstrap -w server" instead.');
  const reset = process.argv.includes('--reset');
  const existing = await prisma.organization.findFirst();
  if (existing) {
    if (!existing.isDemo) throw new Error(`This database holds real (non-demo) data for "${existing.name}". The demo seed will not touch it.`);
    if (!reset) throw new Error('Demo data already exists. Run with --reset to wipe and re-seed it.');
    await wipeAllTables();
  }

  await syncRbac();
  const org = await prisma.organization.create({
    data: { name: 'Ubumwe Properties (DEMO DATA)', legalName: 'Ubumwe Properties Ltd — sample data', tin: '000000000', address: 'KN 2 Ave, Kigali', phone: '+250 788 000 000', timezone: TZ, isDemo: true },
  });
  await ensureDefaults(org.id);
  const today = businessDate(TZ);
  const month = startOfMonth(today);

  // ── Users, one per role ──
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const actors: Record<string, Actor> = {};
  const people: Array<[string, string, string]> = [
    ['SUPER_ADMIN', 'admin@demo.rw', 'Demo Admin'], ['MANAGEMENT', 'manager@demo.rw', 'Demo Manager'], ['ACCOUNTANT', 'accountant@demo.rw', 'Demo Accountant'],
    ['CASHIER', 'cashier@demo.rw', 'Demo Cashier'], ['PROPERTY_STAFF', 'staff@demo.rw', 'Demo Property Staff'], ['VIEWER', 'viewer@demo.rw', 'Demo Viewer'],
  ];
  for (const [roleKey, email, fullName] of people) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const user = await prisma.user.create({ data: { orgId: org.id, email, fullName, passwordHash, emailVerifiedAt: new Date(), roles: { create: { roleId: role.id } } } });
    actors[roleKey] = { userId: user.id, orgId: org.id, name: fullName, email, roles: [roleKey], permissions: new Set(SYSTEM_ROLES[roleKey]!.permissions) };
  }
  const admin = actors.SUPER_ADMIN!, manager = actors.MANAGEMENT!, accountant = actors.ACCOUNTANT!, cashier = actors.CASHIER!, staff = actors.PROPERTY_STAFF!;

  // ── Buildings → floors → rooms (every room has its own rent) ──
  const plan = [
    { code: 'UBM', name: 'UBUMWE HOUSE', address: 'KN 2 Ave, Nyarugenge', floors: [['Basement 1', -1, 'B1-0', 7, 250000], ['Ground Floor', 0, 'G-0', 8, 320000], ['First Floor', 1, '1', 8, 200000], ['Second Floor', 2, '2', 7, 160000]] },
    { code: 'KHP', name: 'KIGALI HEIGHTS PLAZA', address: 'KG 7 Ave, Gasabo', floors: [['Ground Floor', 0, 'G-', 7, 380000], ['First Floor', 1, '1', 7, 260000], ['Second Floor', 2, '2', 6, 210000]] },
    { code: 'NTC', name: 'NYABUGOGO TRADE CENTER', address: 'KN 1 Rd, Nyabugogo', floors: [['Ground Floor', 0, 'G', 8, 180000], ['First Floor', 1, '1', 8, 140000], ['Second Floor', 2, '2', 6, 110000]] },
  ] as const;
  const rooms: Array<{ id: string; buildingId: string; floorId: string; rent: number; number: string }> = [];
  const buildingIds: string[] = [];
  for (const b of plan) {
    const building = await createBuilding(admin, { code: b.code, name: b.name, address: b.address, description: 'Demo building' });
    buildingIds.push(building.id);
    for (const [name, level, prefix, count, base] of b.floors) {
      const floor = await createFloor(admin, { buildingId: building.id, name, level });
      for (let i = 1; i <= count; i += 1) {
        const rent = base + ((i * 37) % 9) * 5000;
        const number = `${prefix}${String(i).padStart(2, '0')}`;
        const room = await createRoom(admin, { buildingId: building.id, floorId: floor.id, number, roomType: level <= 0 ? 'Shop' : pick(['Office', 'Shop', 'Store']), monthlyRent: new Decimal(rent), depositRequired: new Decimal(rent), areaSqm: new Decimal(12 + ((i * 7) % 20)) });
        rooms.push({ id: room.id, buildingId: building.id, floorId: floor.id, rent, number });
      }
    }
  }

  // ── Tenants & contracts (≈78% of rooms let) ──
  const methods = await prisma.paymentMethod.findMany({ where: { orgId: org.id } });
  const method = (code: string) => methods.find((m) => m.code === code)!;
  const letRooms = rooms.filter((_, i) => i % 9 !== 4 && i % 11 !== 7);
  let n = 0;
  let refNo = 1000;
  const contracts: Array<{ id: string; tenantId: string; rent: number; start: Date; profile: string; roomNumber: string }> = [];
  for (const room of letRooms) {
    n += 1;
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const tenant = await createTenant(staff, {
      fullName: name, idNumber: `1${1960 + (n % 45)}8${String(1000000 + n * 7919).slice(0, 7)}0${String(n).padStart(2, '0')}`, phone: `+25078${String(8000000 + n * 1373).slice(0, 7)}`,
      email: n % 3 === 0 ? `tenant${n}@example.rw` : null, businessName: `${name.split(' ')[1]} ${pick(BUSINESS)}`, address: 'Kigali', emergencyContactName: `${pick(FIRST)} ${pick(LAST)}`, emergencyContactPhone: `+25073${String(5000000 + n * 911).slice(0, 7)}`,
    });
    // Contract began 2–7 months ago; most run 12 months. A few end soon so the "expiring" alerts have content.
    const monthsAgo = 2 + (n % 6);
    const start = addMonths(month, -monthsAgo);
    let end = addDays(addMonths(start, 12), -1);
    if (n % 13 === 0) end = addDays(today, 6 + (n % 20));
    if (n === 5) end = addDays(today, -9);
    const contract = await createContract(staff, { tenantId: tenant.id, roomId: room.id, startDate: start, endDate: end, activate: true });
    const profile = n % 10 === 3 ? 'late' : n % 10 === 6 ? 'partial' : n % 14 === 9 ? 'arrears' : n % 16 === 1 ? 'advance' : 'good';
    contracts.push({ id: contract.id, tenantId: tenant.id, rent: room.rent, start, profile, roomNumber: room.number });
    if (n % 2 === 0) await recordDepositPayment(accountant, { contractId: contract.id, amount: new Decimal(room.rent), txnDate: start, methodId: method('BANK').id, reference: `DEP${refNo++}` });
  }

  // ── Payment history, month by month, back-dated to when it "happened" ──
  let key = 0;
  const paymentIds: string[] = [];
  const pay = async (c: (typeof contracts)[number], wanted: number, on: Date, advance = false) => {
    let amount = wanted;
    if (!advance) {
      // Never try to pay more than is owed (a partial last month is billed pro rata).
      const open = await prisma.rentCharge.aggregate({ where: { contractId: c.id, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, _sum: { balance: true } });
      amount = Math.min(wanted, Number(open._sum.balance ?? 0));
      if (amount <= 0) return;
    }
    const m = pick([method('CASH'), method('MOBILE_MONEY'), method('MOBILE_MONEY'), method('BANK'), method('AIRTEL_MONEY')]);
    const when = new Date(Math.min(on.getTime() + 9 * 3_600_000, Date.now() - 60_000));
    const { paymentId } = await recordPayment(advance ? accountant : cashier, {
      contractId: c.id, amount: new Decimal(amount), methodId: m.id, reference: m.requiresReference ? `TX${refNo++}` : undefined, paidAt: when,
      overpayment: advance ? 'ADVANCE' : 'REJECT', idempotencyKey: `seed-${String(key++).padStart(8, '0')}-demo-data`,
    });
    paymentIds.push(paymentId);
  };
  for (const c of contracts) {
    for (let m = c.start; m <= month; m = addMonths(m, 1)) {
      const current = m.getTime() === month.getTime();
      const previous = m.getTime() === addMonths(month, -1).getTime();
      const payDay = addDays(m, 1 + Math.floor(rand() * 6));
      if (current) {
        // The current month has only just begun: a minority have already paid.
        if (payDay <= today && c.profile === 'good' && rand() < 0.25) {
          const due = await prisma.rentCharge.findFirst({ where: { contractId: c.id, period: m, status: { in: ['UNPAID', 'OVERDUE'] } } });
          if (due) await pay(c, Number(due.balance), today);
        }
        continue;
      }
      if (c.profile === 'arrears' && (previous || m.getTime() === addMonths(month, -2).getTime())) continue;
      if (c.profile === 'partial' && previous) {
        await pay(c, Math.round(c.rent * 0.4 / 1000) * 1000, payDay);
        continue;
      }
      if (c.profile === 'late') {
        if (previous) continue;
        await pay(c, c.rent, addDays(m, 18 + Math.floor(rand() * 8)));
        continue;
      }
      if (c.profile === 'advance' && previous) {
        await pay(c, c.rent * 3, payDay, true);
        continue;
      }
      // Occasionally settle a month in two instalments.
      if (rand() < 0.12) {
        const firstPart = Math.round(c.rent * 0.5 / 1000) * 1000;
        await pay(c, firstPart, payDay);
        await pay(c, c.rent - firstPart, addDays(payDay, 4));
      } else {
        await pay(c, c.rent, payDay);
      }
    }
  }

  // Verification and EBM references for most (not all) payments, leaving real work on the dashboards.
  for (const [i, id] of paymentIds.entries()) {
    if (i % 7 !== 0) await verifyPayment(accountant, id).catch(() => undefined);
    if (i % 6 !== 0) {
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { paymentId: id } });
      await updateInvoice(accountant, invoice.id, { status: 'ISSUED', ebmReference: `EBM-DEMO-${String(100000 + i)}` });
    }
  }

  // ── A reversal requested by the cashier and approved by management ──
  const wrong = paymentIds[paymentIds.length - 3]!;
  const reversal = await submitApproval(cashier, { type: 'PAYMENT_REVERSAL', entityType: 'Payment', entityId: wrong, summary: 'Reverse payment recorded against the wrong tenant (demo)', reason: 'Recorded against the wrong tenant', payload: {} });
  await decideApproval(manager, reversal.approval.id, true, 'Confirmed with the cashier');
  // …and a discount request still waiting for a decision.
  const discounted = contracts.find((c) => c.profile === 'good')!;
  await submitApproval(accountant, {
    type: 'RENT_ADJUSTMENT', entityType: 'Contract', entityId: discounted.id, summary: `Discount of 20,000 RWF/month — room ${discounted.roomNumber} (demo)`, reason: 'Long-standing tenant; agreed with management',
    payload: { type: 'DISCOUNT', amount: '20000.00', effectiveFrom: isoDate(addMonths(month, 1)), effectiveTo: isoDate(endOfMonth(addMonths(month, 3))) },
  });

  // ── Renewal of the contract that had expired ──
  const expired = await prisma.contract.findFirst({ where: { orgId: org.id, endDate: { lt: today }, status: { in: ['ACTIVE', 'EXPIRING', 'EXPIRED'] } } });
  if (expired && contracts.length % 2 === 0) await renewContract(manager, expired.id, { endDate: addDays(addMonths(expired.endDate, 12), 0) });

  // ── Expenses over the last three months ──
  const categories = await prisma.expenseCategory.findMany({ where: { orgId: org.id } });
  const cat = (name: string) => categories.find((c) => c.name === name)!.id;
  const expenseRows: Array<[number, string, string, number, 'ORGANIZATION' | 'BUILDING' | 'ROOM', number]> = [
    [2, 'Electricity', 'Electricity bill (EUCL)', 420000, 'BUILDING', 0], [2, 'Water', 'Water bill (WASAC)', 95000, 'BUILDING', 0], [2, 'Security', 'Security guards — monthly contract', 300000, 'BUILDING', 1],
    [2, 'Cleaning', 'Cleaning service', 180000, 'BUILDING', 2], [2, 'Salaries', 'Staff salaries', 1450000, 'ORGANIZATION', 0],
    [1, 'Electricity', 'Electricity bill (EUCL)', 445000, 'BUILDING', 0], [1, 'Water', 'Water bill (WASAC)', 101000, 'BUILDING', 1], [1, 'Security', 'Security guards — monthly contract', 300000, 'BUILDING', 1],
    [1, 'Cleaning', 'Cleaning service', 180000, 'BUILDING', 2], [1, 'Salaries', 'Staff salaries', 1450000, 'ORGANIZATION', 0], [1, 'Repairs', 'Roof gutter repair', 260000, 'BUILDING', 2],
    [1, 'Taxes', 'Property tax instalment', 600000, 'ORGANIZATION', 0], [0, 'Supplies', 'Cleaning supplies', 54000, 'BUILDING', 0], [0, 'Transport', 'Transport — bank deposits', 18000, 'ORGANIZATION', 0],
  ];
  for (const [monthsAgo, category, description, amount, scope, b] of expenseRows) {
    const date = monthsAgo === 0 ? today : addDays(addMonths(month, -monthsAgo), 9 + (amount % 12));
    const e = await createExpense(accountant, { scope, buildingId: scope === 'BUILDING' ? buildingIds[b] : undefined, categoryId: cat(category), description, amount: new Decimal(amount), expenseDate: date, methodId: method('BANK').id, supplier: description.split(' ')[0], reference: `PV-${refNo++}` });
    if (monthsAgo > 0) await decideExpense(manager, e.id, 'APPROVED');
  }

  // ── Maintenance, one linked to an approved expense ──
  const occupiedRoom = rooms.find((r) => r.id === letRooms[3]!.id)!;
  const leak = await createMaintenance(staff, { buildingId: occupiedRoom.buildingId, roomId: occupiedRoom.id, title: 'Leaking ceiling', description: 'Water stain spreading above the counter.', priority: 'HIGH', estimatedCost: new Decimal(150000), supplier: 'Kigali Plumbing Co.' });
  await updateMaintenance(manager, leak.id, { status: 'APPROVED' });
  await updateMaintenance(manager, leak.id, { assignedToId: staff.userId, status: 'IN_PROGRESS' });
  const leakCost = await createExpense(accountant, { scope: 'ROOM', roomId: occupiedRoom.id, categoryId: cat('Maintenance'), description: 'Ceiling leak repair — materials and labour', amount: new Decimal(135000), expenseDate: addDays(today, -1) < month ? today : addDays(today, -1), methodId: method('CASH').id, supplier: 'Kigali Plumbing Co.', maintenanceRequestId: leak.id });
  await decideExpense(manager, leakCost.id, 'APPROVED');
  await updateMaintenance(manager, leak.id, { status: 'COMPLETED', actualCost: new Decimal(135000) });

  const vacant = rooms.filter((r) => !letRooms.includes(r));
  await createMaintenance(staff, { buildingId: vacant[0]!.buildingId, roomId: vacant[0]!.id, title: 'Repaint before re-letting', priority: 'MEDIUM', estimatedCost: new Decimal(90000), markRoomUnderMaintenance: true });
  await createMaintenance(staff, { buildingId: buildingIds[1]!, title: 'Lift out of service', description: 'Lift stops between first and second floor.', priority: 'CRITICAL', supplier: 'Elevator Services Rwanda' });
  await createMaintenance(cashier.permissions.has('maintenance.manage') ? cashier : staff, { buildingId: buildingIds[2]!, title: 'Broken corridor light — first floor', priority: 'LOW' });

  // ── A reservation on a vacant room ──
  await createReservation(staff, { roomId: vacant[2]!.id, prospectName: 'Alice Mutesi', prospectPhone: '+250788123456', reservedOn: today, expiresOn: addDays(today, 10), depositAmount: new Decimal(50000), notes: 'Wants to open a bakery outlet.' });

  // ── Close the accounting period from three months ago ──
  await closePeriod(manager, addMonths(month, -3), 'Demo: period closed after month-end review').catch(() => undefined);

  await runDailyJobs(org.id);

  const [r, t, c, p] = await Promise.all([prisma.room.count(), prisma.tenant.count(), prisma.contract.count(), prisma.payment.count()]);
  console.log(`\nDEMO DATA seeded: 3 buildings, ${r} rooms, ${t} tenants, ${c} contracts, ${p} ledger entries.`);
  console.log('Sign in with any of these DEMO accounts (all share the same password):');
  for (const [role, email] of people) console.log(`  ${role.padEnd(15)} ${email}`);
  console.log(`  password: ${process.env.SEED_PASSWORD ? '(the SEED_PASSWORD you provided)' : DEMO_PASSWORD}`);
  console.log('These accounts and all records are sample data. Never use this seed on a production database.\n');
}

main()
  .catch((err) => {
    console.error(`Seed failed: ${err instanceof Error ? err.stack : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
