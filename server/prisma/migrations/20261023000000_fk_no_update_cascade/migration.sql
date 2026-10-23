-- Newer MariaDB releases refuse CHECK constraints and generated columns built on a foreign-key column whose
-- update action is CASCADE. Ids never change, so these keys restrict updates instead. Since this change the init
-- migration already creates them that way; this brings databases created before it to the same state.

ALTER TABLE `room_rent_rates` DROP FOREIGN KEY `room_rent_rates_roomId_fkey`;
ALTER TABLE `room_rent_rates` ADD CONSTRAINT `room_rent_rates_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `contracts` DROP FOREIGN KEY `contracts_roomId_fkey`;
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `contract_rent_rates` DROP FOREIGN KEY `contract_rent_rates_contractId_fkey`;
ALTER TABLE `contract_rent_rates` ADD CONSTRAINT `contract_rent_rates_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `reservations` DROP FOREIGN KEY `reservations_roomId_fkey`;
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `rent_charges` DROP FOREIGN KEY `rent_charges_contractId_fkey`;
ALTER TABLE `rent_charges` ADD CONSTRAINT `rent_charges_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `payments` DROP FOREIGN KEY `payments_methodId_fkey`;
ALTER TABLE `payments` ADD CONSTRAINT `payments_methodId_fkey` FOREIGN KEY (`methodId`) REFERENCES `payment_methods`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `payments` DROP FOREIGN KEY `payments_reversesId_fkey`;
ALTER TABLE `payments` ADD CONSTRAINT `payments_reversesId_fkey` FOREIGN KEY (`reversesId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `expenses` DROP FOREIGN KEY `expenses_buildingId_fkey`;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `expenses` DROP FOREIGN KEY `expenses_floorId_fkey`;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_floorId_fkey` FOREIGN KEY (`floorId`) REFERENCES `floors`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `expenses` DROP FOREIGN KEY `expenses_roomId_fkey`;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
