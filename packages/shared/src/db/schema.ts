import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const tstzrange = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "tstzrange";
  },
});

// --- Shops (multi-tenancy foundation) ---

export const shops = pgTable("shops", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  timezone: varchar("timezone", { length: 100 }).default("America/Los_Angeles"),
  laborRateCents: integer("labor_rate_cents").default(12000),
  taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 4 }).default("0.1000"),
  stripeAccountId: varchar("stripe_account_id", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const userRoleEnum = pgEnum("user_role", ["customer", "admin", "mechanic"]);

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id").references(() => shops.id),
  name: varchar("name", { length: 255 }),
  phone: varchar("phone", { length: 20 }),
  email: varchar("email", { length: 255 }),
  address: text("address"),
  vehicleInfo: jsonb("vehicle_info").$type<VehicleInfo | null>(),
  stripeCustomerId: varchar("stripe_customer_id", { length: 100 }),
  authUserId: varchar("auth_user_id", { length: 255 }).unique(),
  role: userRoleEnum("role").notNull().default("customer"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const providers = pgTable("providers", {
  id: serial("id").primaryKey(),
  authUserId: varchar("auth_user_id", { length: 255 }).unique(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 20 }),
  isActive: boolean("is_active").notNull().default(true),
  timezone: varchar("timezone", { length: 50 }).notNull().default("America/Los_Angeles"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
    .notNull(),
});

export const providerAvailability = pgTable("provider_availability", {
  id: serial("id").primaryKey(),
  providerId: integer("provider_id").references(() => providers.id, { onDelete: "cascade" })
    .notNull(),
  dayOfWeek: integer("day_of_week").notNull(),
  // Stored as TIME in DB; varchar here because Drizzle returns TIME as string
  startTime: varchar("start_time", { length: 8 }).notNull(),
  endTime: varchar("end_time", { length: 8 }).notNull(),
});

export const providerScheduleOverrides = pgTable("provider_schedule_overrides", {
  id: serial("id").primaryKey(),
  providerId: integer("provider_id").references(() => providers.id, { onDelete: "cascade" })
    .notNull(),
  overrideDate: varchar("override_date", { length: 10 }).notNull(),
  isAvailable: boolean("is_available").notNull().default(false),
  startTime: varchar("start_time", { length: 8 }),
  endTime: varchar("end_time", { length: 8 }),
  reason: text("reason"),
});

export const pricingConfig = pgTable("pricing_config", {
  key: varchar("key", { length: 50 }).primaryKey(),
  value: integer("value").notNull(),
  description: text("description"),
});

// --- OrderItem type (unified item model) ---

/**
 * Repair urgency tier — surfaces severity in the estimate so customers can
 * triage. Required = safety-critical / vehicle inoperable; recommended =
 * fix soon, not urgent; maintenance = routine service interval; optional =
 * cosmetic / nice-to-have.
 */
export type ItemTier = "required" | "recommended" | "maintenance" | "optional";

export interface OrderItem {
  id: string;
  category: "labor" | "parts" | "fee" | "discount";
  name: string;
  description?: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  laborHours?: number;
  partNumber?: string;
  taxable: boolean;
  // Soft reference back to OLP labor reference data (for analytics + future
  // bulk-reprice). No FK constraint — OLP rows are immutable history once
  // priced into an order, but the id lets us aggregate "most-ordered jobs".
  olpLaborTimeId?: number;
  tier?: ItemTier;
}

// --- jsonb shapes (declared once so Drizzle $inferSelect knows them) ---

// Year is stored as a string because the production write-paths in
// gateway/agent stringify it (`String(year)`). Display callers can parse
// to number when needed; storing as string preserves user-entered values
// like "2020.5" or empty string and matches what's already in Postgres.
export interface VehicleInfo {
  year?: string;
  make?: string;
  model?: string;
}

export interface OrderStatusHistoryEntry {
  status: string;
  timestamp: string;
  actor: string;
}

// --- Orders (central entity — single source of truth for lifecycle) ---

export const orderStatusEnum = pgEnum("order_status", [
  "draft",
  "estimated",
  "revised",
  "approved",
  "declined",
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "card",
  "check",
  "venmo",
  "zelle",
  "stripe",
  "other",
]);

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  shopId: uuid("shop_id").references(() => shops.id),
  customerId: integer("customer_id").references(() => customers.id).notNull(),
  status: orderStatusEnum("status").notNull().default("draft"),
  statusHistory: jsonb("status_history").$type<OrderStatusHistoryEntry[]>().notNull().default(
    [],
  ),
  items: jsonb("items").$type<OrderItem[]>().notNull().default([]),
  notes: text("notes"),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  priceRangeLowCents: integer("price_range_low_cents"),
  priceRangeHighCents: integer("price_range_high_cents"),
  vehicleInfo: jsonb("vehicle_info").$type<VehicleInfo | null>(),
  validDays: integer("valid_days").default(30),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  shareToken: varchar("share_token", { length: 64 }).unique(),
  revisionNumber: integer("revision_number").notNull().default(1),
  // Actual amount paid by the customer (renamed from capturedAmountCents
  // — Stripe "captured" semantics no longer apply now that payment is
  // recorded manually). Falls back to subtotalCents in revenue rollups.
  paidAmountCents: integer("paid_amount_cents"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paymentMethod: paymentMethodEnum("payment_method"),
  paymentReference: varchar("payment_reference", { length: 255 }),
  adminNotes: text("admin_notes"),
  // Mechanic's confirmed diagnosis after the on-site visit ("what it actually
  // was"). Paired with order_intake.symptom_description (the customer's original
  // complaint) to form the labeled (symptom → truth) data the diagnostic model
  // trains on. Nullable: filled on/after the visit.
  confirmedDiagnosis: text("confirmed_diagnosis"),
  // Soft, FK-less link to the fixo_predictions row whose diagnose/estimate drove
  // this order. Set at create when the brain produced a predictionId; null for
  // orders not driven by a Fixo prediction. The join key for the calibration
  // loop — no FK, so Fixo and HMLS stay decoupled.
  fixoPredictionId: varchar("fixo_prediction_id", { length: 64 }),
  cancellationReason: text("cancellation_reason"),
  // Per-order contact snapshot — edit these instead of mutating the customers record
  contactName: varchar("contact_name", { length: 255 }),
  contactEmail: varchar("contact_email", { length: 255 }),
  contactPhone: varchar("contact_phone", { length: 20 }),
  contactAddress: text("contact_address"),
  // Scheduling (absorbed from bookings — Layer 3)
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  appointmentEnd: timestamp("appointment_end", { withTimezone: true }),
  durationMinutes: integer("duration_minutes"),
  providerId: integer("provider_id").references(() => providers.id),
  location: text("location"),
  locationLat: numeric("location_lat", { precision: 10, scale: 7 }),
  locationLng: numeric("location_lng", { precision: 10, scale: 7 }),
  accessInstructions: text("access_instructions"),
  blockedRange: tstzrange("blocked_range"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow()
    .notNull(),
}, (table) => ({
  statusIdx: index("orders_status_idx").on(table.status),
  customerIdx: index("orders_customer_id_idx").on(table.customerId),
  scheduledAtIdx: index("orders_scheduled_at_idx").on(table.scheduledAt),
  providerIdx: index("orders_provider_id_idx").on(table.providerId),
}));

// --- Order Intake (customer-submitted intake; 1:1 child of orders) ---
//
// A row exists iff the customer actually submitted intake (e.g. via the
// AI chat flow). Walk-in admin orders and routine-maintenance reorders
// have NO row. Use a LEFT JOIN when reading; null intake means
// "shop-created order, no customer-side narrative".

export const orderIntake = pgTable("order_intake", {
  orderId: integer("order_id")
    .primaryKey()
    .references(() => orders.id, { onDelete: "cascade" }),
  symptomDescription: text("symptom_description"),
  photoUrls: jsonb("photo_urls").$type<string[] | null>(),
  customerNotes: text("customer_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- Order Events (audit log) ---

export const orderEventTypeEnum = pgEnum("order_event_type", [
  "status_change",
  "items_edited",
  "schedule_attached",
  "provider_assigned",
  "payment_recorded",
  "note_added",
  // Historical: no current code path writes this. Kept in the enum so the
  // 13 legacy dev rows survive the cast in migration 0018. The admin/portal
  // event-feed default branch formats unrecognized types automatically.
  "contact_edited",
]);

export const orderEvents = pgTable("order_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: integer("order_id").references(() => orders.id, { onDelete: "cascade" }).notNull(),
  eventType: orderEventTypeEnum("event_type").notNull(),
  fromStatus: varchar("from_status", { length: 50 }),
  toStatus: varchar("to_status", { length: 50 }),
  actor: varchar("actor", { length: 100 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
    .notNull(),
});

// --- OLP (Open Labor Project) reference data ---

export const olpVehicles = pgTable("olp_vehicles", {
  id: serial("id").primaryKey(),
  make: varchar("make", { length: 100 }).notNull(),
  makeSlug: varchar("make_slug", { length: 100 }).notNull(),
  model: varchar("model", { length: 100 }).notNull(),
  modelSlug: varchar("model_slug", { length: 100 }).notNull(),
  yearRange: varchar("year_range", { length: 20 }).notNull(),
  yearStart: integer("year_start").notNull(),
  yearEnd: integer("year_end").notNull(),
  engine: varchar("engine", { length: 50 }).notNull(),
  engineSlug: varchar("engine_slug", { length: 50 }).notNull(),
  fuelType: varchar("fuel_type", { length: 20 }),
  timingType: varchar("timing_type", { length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueVehicle: unique().on(table.makeSlug, table.modelSlug, table.yearRange, table.engineSlug),
}));

export const olpLaborTimes = pgTable("olp_labor_times", {
  id: serial("id").primaryKey(),
  vehicleId: integer("vehicle_id").references(() => olpVehicles.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 200 }).notNull(),
  category: varchar("category", { length: 50 }).notNull(),
  laborHours: numeric("labor_hours", { precision: 5, scale: 2 }).notNull(),
}, (table) => ({
  uniqueJob: unique().on(table.vehicleId, table.slug),
}));

// --- Fixo tables ---

// 'pro' is a future-ready extension point — no Stripe Product/Price exists
// yet. Webhook tier resolution (tierFromPriceId) returns null for unknown
// price IDs, so adding Pro is a Dashboard + env var change with no code/
// migration work.
export const userTierEnum = pgEnum("user_tier", ["free", "plus", "pro"]);

export const userProfiles = pgTable(
  "user_profiles",
  {
    id: uuid("id").primaryKey(), // matches auth.users.id
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    tier: userTierEnum("tier").default("free").notNull(),
    // Credits granted on subscription period (Plus = 2000, Pro = 6000) or
    // free monthly refresh (Free = 100). Reset to the new grant on each
    // period boundary (overwrite, not add — this is the expiry mechanism).
    creditsMonthlyRemaining: integer("credits_monthly_remaining")
      .notNull()
      .default(0),
    // Credits bought via one-time top-up. Never expire. Consumed only
    // after monthly bucket is empty.
    creditsTopupRemaining: integer("credits_topup_remaining")
      .notNull()
      .default(0),
    // When the current monthly grant period started. Used by the lazy
    // refresh path to decide if a new free grant is due (rolling 30-day
    // window). Plus users get refreshed by Stripe `invoice.payment_succeeded`
    // — we still update this field for symmetry.
    monthlyGrantPeriodStart: timestamp("monthly_grant_period_start", {
      withTimezone: true,
    }),
    // Out-of-order webhook protection. Subscription.* handlers only apply
    // an event if its event.created is newer than this column. Stripe
    // doesn't guarantee delivery order; without this guard, a stale
    // `subscription.deleted` arriving after a fresh `subscription.created`
    // would flip the user back to free.
    lastSubscriptionEventAt: timestamp("last_subscription_event_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_user_profiles_stripe").on(table.stripeCustomerId),
    check(
      "user_profiles_credits_monthly_nonneg",
      sql`${table.creditsMonthlyRemaining} >= 0`,
    ),
    check(
      "user_profiles_credits_topup_nonneg",
      sql`${table.creditsTopupRemaining} >= 0`,
    ),
  ],
);

// --- Credit ledger (audit trail) ---

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id, { onDelete: "cascade" }),
    // Positive = grant or top-up purchase or refund. Negative = consumption.
    delta: integer("delta").notNull(),
    // Which bucket this row touched: 'monthly' or 'topup'.
    bucket: text("bucket").notNull(),
    // 'subscription_grant' | 'free_monthly_grant' | 'topup_purchase' |
    // 'consumption' | 'refund' | 'admin_adjustment' | 'legacy_migration'
    reason: text("reason").notNull(),
    // For 'consumption' rows: the session that triggered the charge.
    sessionId: integer("session_id").references(() => fixoSessions.id, {
      onDelete: "set null",
    }),
    // For 'consumption' rows: which kind of input (text/photo/audio/...).
    inputType: text("input_type"),
    // For Stripe-driven rows: the event.id, used as an idempotency key
    // against retries. Unique partial index enforces this.
    stripeEvent: text("stripe_event"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_credit_ledger_user").on(
      table.userId,
      table.createdAt.desc(),
    ),
    uniqueIndex("idx_credit_ledger_stripe_event")
      .on(table.stripeEvent)
      .where(sql`stripe_event IS NOT NULL`),
    check(
      "credit_ledger_bucket_valid",
      sql`${table.bucket} IN ('monthly', 'topup')`,
    ),
  ],
);

// --- Promo codes (bonus credits, non-monetary) ---
//
// Stripe coupons can only do $/% discounts. Codes that grant credits
// without a monetary discount (influencer codes, beta rewards, referrals)
// live here.

export const promoCodes = pgTable(
  "promo_codes",
  {
    code: text("code").primaryKey(),
    credits: integer("credits").notNull(),
    maxUses: integer("max_uses").notNull().default(1),
    uses: integer("uses").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("promo_codes_credits_positive", sql`${table.credits} > 0`),
    check("promo_codes_max_uses_positive", sql`${table.maxUses} > 0`),
    check("promo_codes_uses_nonneg", sql`${table.uses} >= 0`),
    check("promo_codes_uses_le_max", sql`${table.uses} <= ${table.maxUses}`),
  ],
);

export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    code: text("code")
      .notNull()
      .references(() => promoCodes.code, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id, { onDelete: "cascade" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ledgerId: bigint("ledger_id", { mode: "number" }),
  },
  (table) => [
    unique("promo_redemptions_code_user_unique").on(table.code, table.userId),
    index("idx_promo_redemptions_user").on(
      table.userId,
      table.redeemedAt.desc(),
    ),
  ],
);

export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id),
    year: integer("year"),
    make: text("make").notNull(),
    model: text("model").notNull(),
    vin: text("vin"),
    nickname: text("nickname"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_vehicles_user").on(table.userId)],
);

export const mediaTypeEnum = pgEnum("fixo_media_type", [
  "photo",
  "audio",
  "video",
  "obd_photo",
]);

export const processingStatusEnum = pgEnum("fixo_processing_status", [
  "pending",
  "processing",
  "complete",
  "failed",
]);

export const obdSourceEnum = pgEnum("fixo_obd_source", [
  "manual",
  "bluetooth",
  "ocr",
]);

// --- DiagnosticState (Fixo agent's structured 8-step diagnostic memory) ---
//
// Persisted on fixo_sessions.diagnostic_state (jsonb). Mutated by the
// `update_diagnostic_state` agent tool, read each turn by buildAgentContext
// and surfaced in the system prompt so the agent has durable diagnostic
// memory that survives context-window summarization.
//
// The shape mirrors the 8 shop diagnostic stages:
//   1 intake → 2 visual → 3 dtcs → 4 (reproduce — captured as testsDone) →
//   5 candidateSystems → 6 testsPlanned/testsDone → 7 rootCause →
//   8 estimateTiers
//
// Every field is optional; an empty `{}` means "fresh diagnostic, start at intake".

export interface DiagnosticIntake {
  primarySymptom?: string;
  /** When the symptom appears: continuous, situational (cold/hot/load/...), etc. */
  onset?: "always" | "intermittent" | "cold" | "hot" | "load" | "speed-dep";
  /** Free-form frequency description, e.g. "every cold start, gone after 30s". */
  frequency?: string;
  warningLights?: string[];
  recentRepairs?: string;
  drivable?: "safe" | "limp" | "no-start";
}

export interface DiagnosticCandidateSystem {
  /** "fuel", "ignition", "vacuum", "cooling", "brakes", etc. */
  system: string;
  /** 0=ruled-out, 1=low, 2=medium, 3=high. */
  confidence: 0 | 1 | 2 | 3;
  reasons: string[];
}

export interface DiagnosticTestResult {
  test: string;
  result: string;
  /** ISO timestamp from the agent turn that recorded this result. */
  recordedAt?: string;
}

export interface DiagnosticEstimateTier {
  service: string;
  tier: ItemTier;
}

export interface DiagnosticState {
  intake?: DiagnosticIntake;
  visual?: { observations: string[] };
  dtcs?: Array<{ code: string; freezeFrame?: Record<string, unknown> }>;
  candidateSystems?: DiagnosticCandidateSystem[];
  testsPlanned?: string[];
  testsDone?: DiagnosticTestResult[];
  rootCause?: string;
  estimateTiers?: DiagnosticEstimateTier[];
  notes?: string;
}

export const fixoSessions = pgTable(
  "fixo_sessions",
  {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id")
      .references(() => customers.id),
    userId: uuid("user_id").references(() => userProfiles.id),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    creditsCharged: integer("credits_charged").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    messages: jsonb("messages"),
    title: text("title"),
    titleIsUserSet: boolean("title_is_user_set").notNull().default(false),
    summary: text("summary"),
    lastSummarizedMessageId: text("last_summarized_message_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    diagnosticState: jsonb("diagnostic_state")
      .$type<DiagnosticState>()
      .notNull()
      .default({}),
  },
  (table) => [
    index("idx_fixo_sessions_customer").on(table.customerId),
    index("idx_fixo_sessions_user_last_msg")
      .on(table.userId, table.lastMessageAt.desc())
      .where(sql`archived_at IS NULL`),
  ],
);

export const fixoReports = pgTable(
  "fixo_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => fixoSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id, { onDelete: "cascade" }),
    result: jsonb("result").notNull(),
    vehicleSnapshot: jsonb("vehicle_snapshot"),
    mediaSnapshot: jsonb("media_snapshot").notNull().default([]),
    estimateSnapshot: jsonb("estimate_snapshot"),
    messageCount: integer("message_count").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_fixo_reports_session").on(table.sessionId, table.generatedAt.desc()),
    index("idx_fixo_reports_user").on(table.userId, table.generatedAt.desc()),
  ],
);

export const fixoMessageEvents = pgTable(
  "fixo_message_events",
  {
    userMessageId: text("user_message_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfiles.id, { onDelete: "cascade" }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => fixoSessions.id, { onDelete: "cascade" }),
    month: date("month").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_fixo_msg_events_user_month").on(table.userId, table.month)],
);

export const fixoMedia = pgTable(
  "fixo_media",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => fixoSessions.id, { onDelete: "cascade" }),
    type: mediaTypeEnum("type").notNull(),
    storageKey: text("r2_key").notNull(),
    creditCost: integer("credit_cost").notNull(),
    metadata: jsonb("metadata"),
    processingStatus: processingStatusEnum("processing_status")
      .notNull()
      .default("pending"),
    transcription: text("transcription"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Set to NOW() the first time /task hydrates this row into the chat
    // agent's input. Subsequent turns skip already-hydrated rows so a single
    // upload doesn't get re-fed (and re-billed in vision tokens) on every
    // follow-up text message. /complete ignores this column and always pulls
    // every row for the final summary.
    hydratedAt: timestamp("hydrated_at"),
  },
  (table) => [index("idx_fixo_media_session").on(table.sessionId)],
);

export const obdCodes = pgTable(
  "fixo_obd_codes",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => fixoSessions.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    source: obdSourceEnum("source").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("idx_fixo_obd_codes_session").on(table.sessionId)],
);

export const fixoEstimates = pgTable(
  "fixo_estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => userProfiles.id, { onDelete: "cascade" })
      .notNull(),
    sessionId: integer("session_id").references(() => fixoSessions.id, {
      onDelete: "set null",
    }),
    vehicleInfo: jsonb("vehicle_info")
      .$type<{ year: number; make: string; model: string }>()
      .notNull(),
    items: jsonb("items").$type<OrderItem[]>().notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    priceRangeLowCents: integer("price_range_low_cents").notNull(),
    priceRangeHighCents: integer("price_range_high_cents").notNull(),
    shareToken: text("share_token").unique().notNull(),
    validDays: integer("valid_days").notNull().default(14),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_fixo_estimates_user_id").on(table.userId),
    index("idx_fixo_estimates_session_id").on(table.sessionId),
  ],
);

// Channel attribution + funnel telemetry for fixo推广 (CEO plan 2026-05-14).
// Powers D5 kill criteria SQL queries (per-channel CTR, channel → paid
// conversion). Distinct from fixo_message_events (which is credit-billing
// per-AI-call). event_name + channel are free-form text, not enums — the
// fixo推广 wedge may switch over the next 90 days, and we want to add new
// channels (e.g. tiktok_creator_X) or events (e.g. quote_verifier_view)
// without a migration each time.
export const funnelEvents = pgTable(
  "fixo_funnel_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventName: text("event_name").notNull(),
    channel: text("channel").notNull(),
    channelDetail: text("channel_detail"),
    userId: uuid("user_id").references(() => userProfiles.id, {
      onDelete: "set null",
    }),
    sessionId: integer("session_id").references(() => fixoSessions.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_fixo_funnel_channel_event").on(
      table.channel,
      table.eventName,
      table.createdAt,
    ),
    index("idx_fixo_funnel_user").on(table.userId, table.createdAt),
  ],
);

// --- Fixo predictions (the calibration loop's ground-truth store) ---
//
// One row per brain diagnose/estimate call, keyed by the predictionId the brain
// mints (`newPredictionId()`). `recordOutcome` fills the outcome columns by
// predictionId once the mechanic confirms what it actually was — that
// (prediction → confirmed truth) pair is what the diagnostic engine calibrates
// on. `orders.fixo_prediction_id` is the soft, FK-less link back.
export const fixoPredictions = pgTable("fixo_predictions", {
  // The predictionId minted by newPredictionId() (e.g. "pred_<uuid>").
  id: text("id").primaryKey(),
  vehicleInfo: jsonb("vehicle_info").$type<VehicleInfo | null>(),
  symptom: text("symptom"),
  dtcs: jsonb("dtcs").$type<string[] | null>(),
  predictedDiagnosis: jsonb("predicted_diagnosis").$type<
    | { candidateSystems: DiagnosticCandidateSystem[]; rootCause?: string; tests?: string[] }
    | null
  >(),
  predictedEstimate: jsonb("predicted_estimate").$type<
    | {
      items: OrderItem[];
      subtotalCents: number;
      priceRangeLowCents: number;
      priceRangeHighCents: number;
    }
    | null
  >(),
  // Outcome — filled later by recordOutcome (the loop closer).
  confirmedDiagnosis: text("confirmed_diagnosis"),
  actualCostCents: integer("actual_cost_cents"),
  outcomeAt: timestamp("outcome_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Fixo types
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type NewCreditLedgerEntry = typeof creditLedger.$inferInsert;
export type PromoCode = typeof promoCodes.$inferSelect;
export type NewPromoCode = typeof promoCodes.$inferInsert;
export type PromoRedemption = typeof promoRedemptions.$inferSelect;
export type NewPromoRedemption = typeof promoRedemptions.$inferInsert;
export type Vehicle = typeof vehicles.$inferSelect;
export type NewVehicle = typeof vehicles.$inferInsert;
export type FixoSession = typeof fixoSessions.$inferSelect;
export type NewFixoSession = typeof fixoSessions.$inferInsert;
export type FixoMedia = typeof fixoMedia.$inferSelect;
export type NewFixoMedia = typeof fixoMedia.$inferInsert;
export type ObdCode = typeof obdCodes.$inferSelect;
export type NewObdCode = typeof obdCodes.$inferInsert;
export type FixoEstimate = typeof fixoEstimates.$inferSelect;
export type NewFixoEstimate = typeof fixoEstimates.$inferInsert;
export type FixoReport = typeof fixoReports.$inferSelect;
export type NewFixoReport = typeof fixoReports.$inferInsert;
export type FixoMessageEvent = typeof fixoMessageEvents.$inferSelect;
export type NewFixoMessageEvent = typeof fixoMessageEvents.$inferInsert;
export type FunnelEvent = typeof funnelEvents.$inferSelect;
export type NewFunnelEvent = typeof funnelEvents.$inferInsert;
export type FixoPrediction = typeof fixoPredictions.$inferSelect;
export type NewFixoPrediction = typeof fixoPredictions.$inferInsert;
