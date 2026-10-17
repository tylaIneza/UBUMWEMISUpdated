-- One TIN (RDB certificate number) belongs to one tenant. NULLs (older records not filled in yet) are allowed.
CREATE UNIQUE INDEX `tenants_orgId_tin_key` ON `tenants`(`orgId`, `tin`);
