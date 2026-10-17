import type { Tx } from '../db.js';

/**
 * Returns the next number of a gap-free sequence. Must run inside the transaction that
 * uses the number: the sequence row stays locked until commit, so a rolled-back
 * operation does not consume a number and two concurrent operations never share one.
 */
export async function nextNumber(tx: Tx, orgId: string, key: string, year: number): Promise<number> {
  await tx.$executeRaw`
    INSERT INTO sequences (orgId, \`key\`, year, nextValue) VALUES (${orgId}, ${key}, ${year}, 2)
    ON DUPLICATE KEY UPDATE nextValue = nextValue + 1`;
  const rows = await tx.$queryRaw<Array<{ nextValue: number }>>`
    SELECT nextValue FROM sequences WHERE orgId = ${orgId} AND \`key\` = ${key} AND year = ${year}`;
  const next = Number(rows[0]?.nextValue);
  if (!Number.isFinite(next)) throw new Error(`Sequence ${key} could not be read`);
  return next - 1;
}

/** e.g. REC-2026-000001 */
export async function nextDocumentNumber(tx: Tx, orgId: string, key: string, prefix: string, year: number): Promise<string> {
  const n = await nextNumber(tx, orgId, key, year);
  return `${prefix}-${year}-${String(n).padStart(6, '0')}`;
}
