-- "Partial unique" rules: a unique index over a column that holds a key only while the rule applies (NULLs never
-- collide). Newer MariaDB releases refuse generated columns built on foreign-key columns, so each column is a plain
-- column kept up to date by BEFORE INSERT / BEFORE UPDATE triggers. The guarantee is the same: the unique index
-- rejects a second row however it is written. Databases created before this change had generated columns with the
-- same names; they are replaced here (IF EXISTS makes this a no-op on new databases).

-- A room can hold at most ONE occupying contract (ACTIVE / EXPIRING / EXPIRED-not-yet-vacated).
ALTER TABLE `contracts` DROP INDEX IF EXISTS `uq_contract_one_occupant_per_room`;
ALTER TABLE `contracts` DROP COLUMN IF EXISTS `occupyingRoomId`;
ALTER TABLE `contracts` ADD COLUMN `occupyingRoomId` CHAR(36) NULL;
UPDATE `contracts` SET `occupyingRoomId` = `roomId` WHERE `status` IN ('ACTIVE', 'EXPIRING', 'EXPIRED');
ALTER TABLE `contracts` ADD UNIQUE INDEX `uq_contract_one_occupant_per_room` (`occupyingRoomId`);
CREATE TRIGGER `trg_contracts_occupying_insert` BEFORE INSERT ON `contracts` FOR EACH ROW
  SET NEW.`occupyingRoomId` = IF(NEW.`status` IN ('ACTIVE', 'EXPIRING', 'EXPIRED'), NEW.`roomId`, NULL);
CREATE TRIGGER `trg_contracts_occupying_update` BEFORE UPDATE ON `contracts` FOR EACH ROW
  SET NEW.`occupyingRoomId` = IF(NEW.`status` IN ('ACTIVE', 'EXPIRING', 'EXPIRED'), NEW.`roomId`, NULL);

-- A room can hold at most one ACTIVE reservation.
ALTER TABLE `reservations` DROP INDEX IF EXISTS `uq_reservation_one_active_per_room`;
ALTER TABLE `reservations` DROP COLUMN IF EXISTS `activeRoomId`;
ALTER TABLE `reservations` ADD COLUMN `activeRoomId` CHAR(36) NULL;
UPDATE `reservations` SET `activeRoomId` = `roomId` WHERE `status` = 'ACTIVE';
ALTER TABLE `reservations` ADD UNIQUE INDEX `uq_reservation_one_active_per_room` (`activeRoomId`);
CREATE TRIGGER `trg_reservations_active_insert` BEFORE INSERT ON `reservations` FOR EACH ROW
  SET NEW.`activeRoomId` = IF(NEW.`status` = 'ACTIVE', NEW.`roomId`, NULL);
CREATE TRIGGER `trg_reservations_active_update` BEFORE UPDATE ON `reservations` FOR EACH ROW
  SET NEW.`activeRoomId` = IF(NEW.`status` = 'ACTIVE', NEW.`roomId`, NULL);

-- One live (non-void) rent charge per contract per month.
ALTER TABLE `rent_charges` DROP INDEX IF EXISTS `uq_charge_one_live_per_period`;
ALTER TABLE `rent_charges` DROP COLUMN IF EXISTS `liveKey`;
ALTER TABLE `rent_charges` ADD COLUMN `liveKey` VARCHAR(50) NULL;
UPDATE `rent_charges` SET `liveKey` = CONCAT(`contractId`, ':', `period`) WHERE `status` <> 'VOID';
ALTER TABLE `rent_charges` ADD UNIQUE INDEX `uq_charge_one_live_per_period` (`liveKey`);
CREATE TRIGGER `trg_charges_live_insert` BEFORE INSERT ON `rent_charges` FOR EACH ROW
  SET NEW.`liveKey` = IF(NEW.`status` <> 'VOID', CONCAT(NEW.`contractId`, ':', NEW.`period`), NULL);
CREATE TRIGGER `trg_charges_live_update` BEFORE UPDATE ON `rent_charges` FOR EACH ROW
  SET NEW.`liveKey` = IF(NEW.`status` <> 'VOID', CONCAT(NEW.`contractId`, ':', NEW.`period`), NULL);

-- A transaction reference can be used by only one live payment per method.
ALTER TABLE `payments` DROP INDEX IF EXISTS `uq_payment_live_reference`;
ALTER TABLE `payments` DROP COLUMN IF EXISTS `liveReference`;
ALTER TABLE `payments` ADD COLUMN `liveReference` VARCHAR(160) NULL;
UPDATE `payments` SET `liveReference` = CONCAT(`methodId`, ':', `reference`)
  WHERE `type` = 'PAYMENT' AND `status` = 'POSTED' AND `reference` IS NOT NULL;
ALTER TABLE `payments` ADD UNIQUE INDEX `uq_payment_live_reference` (`orgId`, `liveReference`);
CREATE TRIGGER `trg_payments_live_reference_insert` BEFORE INSERT ON `payments` FOR EACH ROW
  SET NEW.`liveReference` = IF(NEW.`type` = 'PAYMENT' AND NEW.`status` = 'POSTED' AND NEW.`reference` IS NOT NULL, CONCAT(NEW.`methodId`, ':', NEW.`reference`), NULL);
CREATE TRIGGER `trg_payments_live_reference_update` BEFORE UPDATE ON `payments` FOR EACH ROW
  SET NEW.`liveReference` = IF(NEW.`type` = 'PAYMENT' AND NEW.`status` = 'POSTED' AND NEW.`reference` IS NOT NULL, CONCAT(NEW.`methodId`, ':', NEW.`reference`), NULL);

-- Only one open-ended rate per room / contract. (Closed rates may not be updated, so only open ones are filled in.)
ALTER TABLE `room_rent_rates` DROP INDEX IF EXISTS `uq_room_rate_one_open`;
ALTER TABLE `room_rent_rates` DROP COLUMN IF EXISTS `openRoomId`;
ALTER TABLE `room_rent_rates` ADD COLUMN `openRoomId` CHAR(36) NULL;
UPDATE `room_rent_rates` SET `openRoomId` = `roomId` WHERE `effectiveTo` IS NULL;
ALTER TABLE `room_rent_rates` ADD UNIQUE INDEX `uq_room_rate_one_open` (`openRoomId`);
CREATE TRIGGER `trg_room_rate_open_insert` BEFORE INSERT ON `room_rent_rates` FOR EACH ROW
  SET NEW.`openRoomId` = IF(NEW.`effectiveTo` IS NULL, NEW.`roomId`, NULL);
CREATE TRIGGER `trg_room_rate_open_update` BEFORE UPDATE ON `room_rent_rates` FOR EACH ROW
  SET NEW.`openRoomId` = IF(NEW.`effectiveTo` IS NULL, NEW.`roomId`, NULL);

ALTER TABLE `contract_rent_rates` DROP INDEX IF EXISTS `uq_contract_rate_one_open`;
ALTER TABLE `contract_rent_rates` DROP COLUMN IF EXISTS `openContractId`;
ALTER TABLE `contract_rent_rates` ADD COLUMN `openContractId` CHAR(36) NULL;
UPDATE `contract_rent_rates` SET `openContractId` = `contractId` WHERE `effectiveTo` IS NULL;
ALTER TABLE `contract_rent_rates` ADD UNIQUE INDEX `uq_contract_rate_one_open` (`openContractId`);
CREATE TRIGGER `trg_contract_rate_open_insert` BEFORE INSERT ON `contract_rent_rates` FOR EACH ROW
  SET NEW.`openContractId` = IF(NEW.`effectiveTo` IS NULL, NEW.`contractId`, NULL);
CREATE TRIGGER `trg_contract_rate_open_update` BEFORE UPDATE ON `contract_rent_rates` FOR EACH ROW
  SET NEW.`openContractId` = IF(NEW.`effectiveTo` IS NULL, NEW.`contractId`, NULL);
