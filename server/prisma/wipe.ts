import { prisma } from '../src/db.js';

const TABLES = [
  'audit_logs', 'message_logs', 'notifications', 'documents', 'payment_allocations', 'receipts', 'invoices', 'payments', 'deposit_transactions',
  'rent_charges', 'rent_adjustments', 'contract_rent_rates', 'approval_requests', 'expenses', 'maintenance_requests', 'reservations', 'contracts',
  'tenants', 'room_rent_rates', 'rooms', 'floors', 'buildings', 'accounting_periods', 'expense_categories', 'payment_methods', 'sequences',
  'auth_tokens', 'sessions', 'user_roles', 'users', 'role_permissions', 'roles', 'permissions', 'organizations',
];

/**
 * Empties every application table. Development and test use ONLY — it is called by the
 * demo seed (demo databases) and the test suite (databases named *_test).
 * TRUNCATE bypasses the append-only triggers, which is exactly why this must never be
 * reachable from the running application.
 */
export async function wipeAllTables(): Promise<void> {
  // One connection for the whole batch: FOREIGN_KEY_CHECKS is a per-connection setting.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  }, { timeout: 60_000 });
}
