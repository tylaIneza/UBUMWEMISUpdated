/**
 * First-time production setup. Idempotent.
 *   - syncs the permission catalog and system roles
 *   - creates the organization (ORG_NAME) if none exists, with default categories and payment methods
 *   - creates the first Super Admin (ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME) if no user exists
 *
 * Usage:  ORG_NAME="…" ADMIN_EMAIL=… ADMIN_PASSWORD=… ADMIN_NAME="…" npm run bootstrap -w server
 */
import { hashPassword, passwordProblem } from '../src/auth/passwords.js';
import { prisma } from '../src/db.js';
import { syncRbac } from '../src/services/rbac.js';
import { ensureDefaults } from '../src/services/settings.js';

async function main() {
  await syncRbac();
  let org = await prisma.organization.findFirst();
  if (!org) {
    const name = process.env.ORG_NAME?.trim();
    if (!name) throw new Error('ORG_NAME is required to create the organization.');
    // This organization bills whole calendar months (no day-based proration); it can be changed in Settings.
    org = await prisma.organization.create({ data: { name, proratePartialMonths: false } });
    console.log(`Organization created: ${org.name}`);
  }
  await ensureDefaults(org.id);

  if ((await prisma.user.count()) === 0) {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD ?? '';
    if (!email) throw new Error('ADMIN_EMAIL is required to create the first administrator.');
    const problem = passwordProblem(password);
    if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
    const user = await prisma.user.create({
      data: { orgId: org.id, email, fullName: process.env.ADMIN_NAME?.trim() || 'Administrator', passwordHash: await hashPassword(password), emailVerifiedAt: new Date(), roles: { create: { roleId: role.id } } },
    });
    await prisma.auditLog.create({ data: { orgId: org.id, action: 'USER_CREATED', entityType: 'User', entityId: user.id, summary: `First Super Admin ${email} created by bootstrap` } });
    console.log(`Super Admin created: ${email}`);
  } else {
    console.log('Users already exist — no administrator created.');
  }
  console.log('Bootstrap complete.');
}

main()
  .catch((err) => {
    console.error(`Bootstrap failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
