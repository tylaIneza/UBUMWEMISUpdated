-- Archived tenants: tenancy ended, unpaid rent waived, hidden from lists (their payments still count in totals).
ALTER TABLE `tenants`
  MODIFY `status` ENUM('ACTIVE', 'INACTIVE', 'FORMER', 'BLACKLISTED', 'ARCHIVED') NOT NULL DEFAULT 'INACTIVE',
  ADD COLUMN `archivedAt` DATETIME(3) NULL AFTER `statusReason`;
