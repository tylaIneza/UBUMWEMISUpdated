import request from 'supertest';
import { SYSTEM_ROLES } from '../src/auth/permissions.js';
import { hashPassword } from '../src/auth/passwords.js';
import { prisma } from '../src/db.js';
import { createApp } from '../src/http/app.js';
import type { Actor } from '../src/http/context.js';
import { addMonths, businessDate, endOfMonth, startOfMonth } from '../src/lib/dates.js';
import { Decimal } from '../src/lib/money.js';
import { dueDatesFor } from '../src/services/charges.js';
import { createContract } from '../src/services/contracts.js';
import { recordPayment, type PaymentInput } from '../src/services/payments.js';
import { createBuilding, createFloor, createRoom } from '../src/services/property.js';
import { syncRbac } from '../src/services/rbac.js';
import { ensureDefaults } from '../src/services/settings.js';
import { createTenant } from '../src/services/tenants.js';
import { wipeAllTables } from '../prisma/wipe.js';

export const PASSWORD = 'Test@Pass2026';
export const TZ = 'Africa/Kigali';
export const today = () => businessDate(TZ);
export const thisMonth = () => startOfMonth(today());
export const monthsAgo = (n: number) => addMonths(thisMonth(), -n);
export const endOfThisMonth = () => endOfMonth(today());
export const d = (v: number | string) => new Decimal(v);
/** Rent terms of the test organization (createWorld): due on the 5th, overdue after 5 days' grace. */
export const DUE_DAY = 5;
export const GRACE_DAYS = 5;
/** Status of an unpaid charge for the current month of a contract started on the 1st — it depends on today's date. */
export const unpaidThisMonth = () => (today() > dueDatesFor({ startDate: thisMonth(), paymentDueDay: DUE_DAY, graceDays: GRACE_DAYS }, thisMonth()).overdueFrom ? 'OVERDUE' : 'UNPAID');

export async function resetDatabase(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ db: string }>>`SELECT DATABASE() AS db`;
  if (!rows[0]?.db.endsWith('_test')) throw new Error(`Refusing to wipe database "${rows[0]?.db}": not a test database.`);
  await wipeAllTables();
}

export type RoleKey = 'SUPER_ADMIN' | 'MANAGEMENT' | 'ACCOUNTANT' | 'CASHIER' | 'PROPERTY_STAFF' | 'VIEWER';
let counter = 0;
export const uid = (prefix = 'k') => `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36).padStart(6, '0')}-test`;

export interface World {
  orgId: string;
  actors: Record<RoleKey, Actor>;
  emails: Record<RoleKey, string>;
  methods: Record<string, string>;
  categories: Record<string, string>;
}

/** A fresh organization with one user per system role, default payment methods and categories. */
export async function createWorld(): Promise<World> {
  await resetDatabase();
  await syncRbac();
  const org = await prisma.organization.create({ data: { name: 'Test Properties', timezone: TZ, defaultDueDay: DUE_DAY, defaultGraceDays: GRACE_DAYS } });
  await ensureDefaults(org.id);
  const passwordHash = await hashPassword(PASSWORD);
  const actors = {} as Record<RoleKey, Actor>;
  const emails = {} as Record<RoleKey, string>;
  for (const key of Object.keys(SYSTEM_ROLES) as RoleKey[]) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key } });
    const email = `${key.toLowerCase()}@test.rw`;
    const user = await prisma.user.create({ data: { orgId: org.id, email, fullName: `Test ${key}`, passwordHash, emailVerifiedAt: new Date(), roles: { create: { roleId: role.id } } } });
    actors[key] = { userId: user.id, orgId: org.id, name: user.fullName, email, roles: [key], permissions: new Set(SYSTEM_ROLES[key]!.permissions) };
    emails[key] = email;
  }
  const methods = Object.fromEntries((await prisma.paymentMethod.findMany({ where: { orgId: org.id } })).map((m) => [m.code, m.id]));
  const categories = Object.fromEntries((await prisma.expenseCategory.findMany({ where: { orgId: org.id } })).map((c) => [c.name, c.id]));
  return { orgId: org.id, actors, emails, methods, categories };
}

export interface BuildingFixture {
  id: string;
  floors: Array<{ id: string; rooms: Array<{ id: string; number: string; rent: number }> }>;
}

/** A building with `floors` floors of `roomsPerFloor` rooms; every room has a different rent. */
export async function makeBuilding(w: World, code: string, floors = 2, roomsPerFloor = 2, baseRent = 100000): Promise<BuildingFixture> {
  const admin = w.actors.SUPER_ADMIN;
  const building = await createBuilding(admin, { code, name: `Building ${code}` });
  const out: BuildingFixture = { id: building.id, floors: [] };
  for (let f = 0; f < floors; f += 1) {
    const floor = await createFloor(admin, { buildingId: building.id, name: `Floor ${f}`, level: f });
    const rooms = [];
    for (let r = 1; r <= roomsPerFloor; r += 1) {
      const rent = baseRent + f * 10000 + r * 1000;
      const room = await createRoom(admin, { buildingId: building.id, floorId: floor.id, number: `${code}-${f}${String(r).padStart(2, '0')}`, monthlyRent: d(rent), depositRequired: d(rent) });
      rooms.push({ id: room.id, number: room.number, rent });
    }
    out.floors.push({ id: floor.id, rooms });
  }
  return out;
}

let tenantNo = 0;
/** A unique, well-formed 16-digit Rwandan national ID number for tests. */
export const rwandanId = () => `1199080${String(Date.now() % 1_000_000).padStart(6, '0')}${String((tenantNo += 1) % 1000).padStart(3, '0')}`;
let tinNo = 0;
/** A unique 9-digit TIN for tests. */
export const tinNumber = () => String(100_000_000 + ((Date.now() % 1_000_000) * 1000 + (tinNo += 1)) % 900_000_000);
/** The TIN and address now required when a tenant is registered through the API. */
export const tenantDetails = () => ({ tin: tinNumber(), district: 'Nyarugenge', sector: 'Kimisagara', cell: 'Kamuhoza', village: 'Akabeza' });
export async function makeTenant(w: World, name?: string) {
  tenantNo += 1;
  return createTenant(w.actors.PROPERTY_STAFF, { fullName: name ?? `Tenant ${tenantNo}`, idNumber: rwandanId(), phone: `+2507880${String(10000 + tenantNo)}` });
}

/** Tenant + active contract on a room, starting `startMonthsAgo` months back and running a year. */
export async function lease(w: World, roomId: string, startMonthsAgo = 0, extra: Partial<Parameters<typeof createContract>[1]> = {}) {
  const tenant = await makeTenant(w);
  const start = monthsAgo(startMonthsAgo);
  const contract = await createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId, startDate: start, endDate: endOfMonth(addMonths(start, 11)), activate: true, ...extra });
  return { tenant, contract };
}

export async function pay(w: World, role: RoleKey, contractId: string, amount: number, extra: Partial<PaymentInput> = {}) {
  const { paymentId } = await recordPayment(w.actors[role], { contractId, amount: d(amount), methodId: w.methods.CASH!, idempotencyKey: uid('pay'), ...extra });
  return prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { allocations: true, receipt: true, invoice: true } });
}

export const charges = (contractId: string) => prisma.rentCharge.findMany({ where: { contractId, status: { not: 'VOID' } }, orderBy: { period: 'asc' } });
export const num = (v: unknown) => Number(v);

// ───────────── HTTP helpers ─────────────

export const app = createApp();

export interface Session {
  cookie: string;
  csrf: string;
  get: (path: string) => request.Test;
  post: (path: string, body?: object) => request.Test;
  patch: (path: string, body?: object) => request.Test;
  put: (path: string, body?: object) => request.Test;
  del: (path: string) => request.Test;
}

export async function loginAs(email: string, password = PASSWORD): Promise<Session> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
  const csrf = me.body.csrfToken as string;
  const base = '/api/v1';
  return {
    cookie, csrf,
    get: (path) => request(app).get(base + path).set('Cookie', cookie),
    post: (path, body = {}) => request(app).post(base + path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body),
    patch: (path, body = {}) => request(app).patch(base + path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body),
    put: (path, body = {}) => request(app).put(base + path).set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body),
    del: (path) => request(app).delete(base + path).set('Cookie', cookie).set('X-CSRF-Token', csrf),
  };
}

// ───────────── Assertions ─────────────

import { AppError } from '../src/errors.js';
import { translateDbError } from '../src/http/errors.js';

/** Awaits a promise that must fail and returns the user-facing error it produces (as the API would). */
export async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    const translated = translateDbError(err);
    if (translated) return translated;
    throw err;
  }
  throw new Error('Expected the operation to be rejected, but it succeeded.');
}
