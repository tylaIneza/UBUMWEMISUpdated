-- Each building uses its own lease contract (a Word file in server/templates). NULL: no contract set up yet.
ALTER TABLE `buildings` ADD COLUMN `contractTemplate` VARCHAR(120) NULL;
