-- Backfill customers.auth_user_id for legacy guest rows where it is still NULL.
-- Conditions for a safe backfill (both guards must hold simultaneously):
--   1. Exactly one auth.users row has the customer's email.
--   2. Exactly one customers row has that email.
-- If either guard fails the row is skipped — the gateway email-fallback will
-- self-heal those rows lazily on next login, reducing cross-shop mis-binding risk.
--
-- Running this migration reduces the number of rows that ever reach the email
-- fallback path in requireAuth / requireShopContext / resolveCustomer, so the
-- hardened "unique-match-only" logic in those paths is exercised less and less
-- over time until all legacy guests have been self-healed.

BEGIN;

UPDATE customers c
SET    auth_user_id = au.id
FROM   auth.users au
WHERE  c.auth_user_id IS NULL
  -- Guard 1: email must match exactly one auth.users row.
  AND au.email = c.email
  AND (
    SELECT count(*)
    FROM   auth.users au2
    WHERE  au2.email = c.email
  ) = 1
  -- Guard 2: email must match exactly one customers row.
  AND (
    SELECT count(*)
    FROM   customers c2
    WHERE  c2.email = c.email
  ) = 1;

COMMIT;
