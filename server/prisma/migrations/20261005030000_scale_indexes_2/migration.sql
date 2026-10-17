-- Newest-first payment list, and "tenants who owe rent", at large scale.
CREATE INDEX `payments_orgId_paidAt_idx` ON `payments`(`orgId`, `paidAt`);
CREATE INDEX `rent_charges_tenantId_status_idx` ON `rent_charges`(`tenantId`, `status`);
