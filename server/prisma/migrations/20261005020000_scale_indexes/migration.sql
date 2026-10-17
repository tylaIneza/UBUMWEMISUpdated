-- Indexes for the dashboard, reminders and lists at tens of thousands of tenants (found by a 15,000-tenant load test).
CREATE INDEX `rent_charges_orgId_dueDate_idx` ON `rent_charges`(`orgId`, `dueDate`);
CREATE INDEX `rent_charges_orgId_status_overdueFrom_idx` ON `rent_charges`(`orgId`, `status`, `overdueFrom`);
CREATE INDEX `payments_orgId_verifiedAt_idx` ON `payments`(`orgId`, `verifiedAt`);
CREATE INDEX `payments_orgId_createdAt_idx` ON `payments`(`orgId`, `createdAt`);
CREATE INDEX `tenants_orgId_createdAt_idx` ON `tenants`(`orgId`, `createdAt`);
CREATE INDEX `contracts_orgId_status_idx` ON `contracts`(`orgId`, `status`);
CREATE INDEX `rooms_buildingId_status_idx` ON `rooms`(`buildingId`, `status`);
