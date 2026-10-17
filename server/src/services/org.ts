import type { Db } from '../db.js';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { businessDate } from '../lib/dates.js';

export async function getOrg(orgId: string, db: Db = prisma) {
  const org = await db.organization.findUnique({ where: { id: orgId } });
  if (!org) throw notFound('Organization');
  return org;
}

/** Today's calendar date for the organization (its configured time zone). */
export async function orgToday(orgId: string, db: Db = prisma): Promise<Date> {
  const org = await getOrg(orgId, db);
  return businessDate(org.timezone);
}
