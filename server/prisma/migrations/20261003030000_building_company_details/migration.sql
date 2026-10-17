-- Each building can belong to its own company: these details are printed on its reports, receipts and lease contracts.
ALTER TABLE `buildings`
  ADD COLUMN `companyName` VARCHAR(160) NULL,
  ADD COLUMN `tin` VARCHAR(40) NULL,
  ADD COLUMN `phone` VARCHAR(40) NULL,
  ADD COLUMN `email` VARCHAR(160) NULL,
  ADD COLUMN `managerName` VARCHAR(160) NULL,
  ADD COLUMN `bankName` VARCHAR(120) NULL,
  ADD COLUMN `bankAccount` VARCHAR(60) NULL,
  ADD COLUMN `upi` VARCHAR(60) NULL,
  ADD COLUMN `district` VARCHAR(80) NULL,
  ADD COLUMN `sector` VARCHAR(80) NULL,
  ADD COLUMN `cell` VARCHAR(80) NULL,
  ADD COLUMN `village` VARCHAR(80) NULL;
