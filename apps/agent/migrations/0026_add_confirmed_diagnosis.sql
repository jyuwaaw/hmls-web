-- Closed-loop "ground truth": the mechanic's confirmed diagnosis after the
-- on-site visit, paired with order_intake.symptom_description (the customer's
-- original complaint). The (symptom → confirmed) pair is the labeled data the
-- diagnostic model trains on. Nullable — filled on/after completion.
--
-- Hand-written: drizzle-kit's journal (apps/agent/migrations/meta/_journal.json)
-- is out of sync with the on-disk migrations (see the 0025 header), so
-- `deno task db:generate` is unsafe. Apply via the production migration path.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_diagnosis text;
