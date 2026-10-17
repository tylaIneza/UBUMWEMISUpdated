-- Tenant details printed on the lease contract. Additive only.
ALTER TABLE `tenants`
  ADD COLUMN `tin` VARCHAR(40) NULL,
  ADD COLUMN `district` VARCHAR(80) NULL,
  ADD COLUMN `sector` VARCHAR(80) NULL,
  ADD COLUMN `cell` VARCHAR(80) NULL,
  ADD COLUMN `village` VARCHAR(80) NULL;
