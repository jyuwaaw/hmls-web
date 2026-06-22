-- Add the 'owner' role (cross-shop super-admin). Standalone, no BEGIN/COMMIT:
-- ALTER TYPE ... ADD VALUE must not be used in the same transaction it is added.
-- 'owner' is NOT referenced anywhere else in this migration set's data steps.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'owner';
