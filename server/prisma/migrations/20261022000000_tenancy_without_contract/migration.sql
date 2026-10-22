-- A tenant can be registered with only a name and room: ID number and phone become optional.
ALTER TABLE `tenants`
  MODIFY `idNumber` VARCHAR(40) NULL,
  MODIFY `phone` VARCHAR(40) NULL;

-- A tenancy can run without a signed contract (leaseStart NULL) until one is given.
ALTER TABLE `contracts` ADD COLUMN `leaseStart` DATE NULL AFTER `endDate`;
UPDATE `contracts` SET `leaseStart` = `startDate`;
