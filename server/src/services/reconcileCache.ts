/**
 * Reconciliation results reused for a minute per organization and period (see reconcileCached in reports.ts).
 * Kept in its own module so that money-changing services can clear it without importing the reports.
 */
export const reconcileCache = new Map<string, { at: number; checks: Promise<unknown> }>();

/** Forget the cached checks of one organization, e.g. right after a payment is recorded or reversed. */
export function clearReconcileCache(orgId: string): void {
  for (const key of reconcileCache.keys()) if (key.startsWith(`${orgId}|`)) reconcileCache.delete(key);
}
