import { sql } from "drizzle-orm";
import {
  boolean,
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

export const userTierEnum = pgEnum("user_tier", ["free", "plus"]);

export const userProfiles = pgTable(
  "user_profiles",
  {
    id: uuid("id").primaryKey(), // matches auth.users.id
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    tier: userTierEnum("tier").default("free").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_user_profiles_stripe").on(table.stripeCustomerId)],
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

// Fixo types
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
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
