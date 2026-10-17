import { beforeAll, describe, expect, it } from 'vitest';
import { generateReport } from '../src/services/reports.js';
import { reportToExcel, reportToPdf } from '../src/services/exporters.js';
import { addMonths, endOfMonth, periodLabel } from '../src/lib/dates.js';
import { createWorld, lease, makeBuilding, num, pay, thisMonth, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'BMR', 1, 3, 100000); // rents 101,000 / 102,000 / 103,000
  const rooms = b.floors[0]!.rooms;
  const first = await lease(w, rooms[0]!.id);
  await pay(w, 'MANAGEMENT', first.contract.id, 101000 * 4, { overpayment: 'ADVANCE' }); // four months at once
  const second = await lease(w, rooms[1]!.id);
  await pay(w, 'MANAGEMENT', second.contract.id, 50000);
});

describe('monthly building report', () => {
  it('lists every room of the building for the month, split into who paid and who did not', async () => {
    const r = await generateReport(w.actors.MANAGEMENT, 'building-monthly', { from: thisMonth(), to: endOfMonth(thisMonth()), buildingId: b.id });
    expect(r.period).toBe(periodLabel(thisMonth()));
    const paid = r.tables.find((t) => t.title === 'Building BMR — tenants who paid')!;
    const unpaid = r.tables.find((t) => t.title === 'Building BMR — tenants who did not pay (or paid only part)')!;
    expect(paid.rows).toHaveLength(1);
    const [a] = paid.rows;
    expect([num(a!.rent), num(a!.paid), a!.paidUntil]).toEqual([101000, 101000, periodLabel(addMonths(thisMonth(), 3))]);
    expect(String(a!.receipts)).toMatch(/^REC-/);
    expect(unpaid.rows).toHaveLength(1); // the vacant room is in neither list
    const [c] = unpaid.rows;
    expect([num(c!.rent), num(c!.paid), num(c!.balance), c!.status]).toEqual([102000, 50000, 52000, 'PARTIAL']);
    expect([num(unpaid.totals!.rent), num(unpaid.totals!.balance)]).toEqual([102000, 52000]);
    expect(r.summary.find((x) => x.label === 'Money expected this month')!.value).toBeDefined();
    const overview = r.tables.find((t) => t.title === 'Buildings')!.rows[0]!;
    // Cash received counts all four months; the three later months show as paid in advance.
    expect([num(overview.expected), num(overview.collected), num(overview.outstanding), num(overview.cashReceived), num(overview.advance)]).toEqual([203000, 151000, 52000, 454000, 303000]);
    expect([overview.paidTenants, overview.partialTenants, overview.unpaidTenants]).toEqual([1, 1, 0]);
    expect(r.tables.some((t) => t.title === 'Building BMR — expenses')).toBe(true);
  });

  it('covers every building when none is chosen, and exports to PDF and Excel', async () => {
    const r = await generateReport(w.actors.MANAGEMENT, 'building-monthly', { from: thisMonth(), to: endOfMonth(thisMonth()) });
    expect(r.tables.find((t) => t.title === 'Buildings')!.rows.map((x) => x.building)).toContain('Building BMR');
    expect((await reportToPdf(r)).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await reportToExcel(r)).subarray(0, 2).toString()).toBe('PK');
  });
});
