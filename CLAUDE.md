# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Build & Development Commands

```bash
# Dev servers
cd apps/hmls-web && bun run dev       # Next.js on port 3000
deno task dev:api                # API + Fixo agent on port 8080
# Main API: http://localhost:8080
# Fixo API: http://fixo.localhost:8080

# Build & quality
cd apps/hmls-web && bun run build     # Build Next.js
cd apps/hmls-web && bun run lint      # Lint with Biome
cd apps/hmls-web && bun run typecheck # TypeScript type checking
deno task check                  # Deno check gateway + agent
deno task lint                   # Deno lint (excludes web)
deno task fmt:check              # Deno format check (excludes web)

# Database (Supabase PostgreSQL — no local DB needed)
deno task --cwd apps/agent db:push      # Push schema changes to DB (dev)
deno task --cwd apps/agent db:generate  # Generate migration files
deno task --cwd apps/agent db:migrate   # Apply migrations (production)
deno task --cwd apps/agent db:studio    # Drizzle Studio GUI
```

## Setup

```bash
cd apps/hmls-web && bun install       # Install web dependencies
git config core.hooksPath .githooks  # Enable pre-commit hook

# Secrets — this repo uses Infisical (not .env.local). Config: .infisical.json at root.
# Run dev servers via infisical so secrets are injected:
infisical run --env=dev -- deno task dev:api
cd apps/hmls-web && GATEWAY_URL=http://localhost:8080 infisical run --env=dev -- bun run dev
# Note: GATEWAY_URL override is required for local web — the /api/chat Next.js route
# defaults to https://api.hmls.autos (prod) and must be pointed at the local API.
```

## Product Direction (as of 2026-04-20)

**Positioning**: AI-powered auto repair estimates for mechanic shops (SaaS). HMLS is the software
vendor; individual shops are the customers. One of those shops is HMLS's own self-operated mobile
mechanic business (dogfood).

**Core wedge**: AI Service Advisor. A customer chats with the shop's AI, gets a real (OLP-priced)
estimate, shop team reviews and sends, customer approves, mechanic assigned, job scheduled,
completed. No payment automation by default — shops record payments manually. Stripe plumbing kept
dormant for shops that want opt-in auto-capture later.

**Single source of truth**: `orders` is THE entity. All work-lifecycle data (including scheduling,
provider assignment, location, symptoms, photos) lives on the order. Legacy tables (`estimates`,
`quotes`, `bookings`) are **dropped** (Layer 3 complete).

## Order lifecycle (simplified status machine)

```
draft → estimated → approved → scheduled → in_progress → completed
           ↓           ↓                        ↓
         declined  cancelled                 cancelled
           ↓
         revised → estimated
```

- `draft` — AI-generated, awaiting shop review
- `estimated` — shop sent the estimate to customer
- `approved` — customer accepted; shop needs to assign mechanic + confirm booking
- `scheduled` — mechanic assigned + booking confirmed
- `in_progress` — mechanic working
- `completed` — done (payment tracked via `paid_at` / `payment_method` / `payment_reference`
  columns, not a status)
- Branches: `declined` (customer declined) / `revised` (shop re-sends) / `cancelled` (terminal)

**Removed states** (migrated in `0008_simplify_status_machine.sql`): `preauth → approved`,
`invoiced → in_progress`, `paid → completed + paid_at`, `archived → completed`, `void → cancelled`.

## Architecture

Deno workspace monorepo for a mobile mechanic business with an AI-powered chat agent. All apps
deploy to **Deno Deploy** (console.deno.com) via GitHub integration. Root config is `deno.json`; web
app uses Bun/Next.js internally. Root `deno.json` `imports` are inherited by all workspace members —
shared deps go there, app-specific deps in each app's `deno.json`.

```
apps/
├── hmls-web/           # Next.js 16 frontend (React 19, Tailwind CSS 4) → Deno Deploy
├── gateway/            # HTTP server (Hono, routing, auth, CORS) → Deno Deploy
└── agent/              # AI agents + domain logic (library package)
    ├── llm/            #   GeminiOpenAIProvider (shared)
    ├── db/             #   Drizzle schema + client (shared)
    ├── hmls/           #   HMLS agent, tools, skills, PDF
    └── fixo/           #   Fixo agent, tools, lib, PDF
packages/
└── shared/             # @hmls/shared — shared utilities (errors, toolResult, db client)
```

### Service Communication & Subdomain Routing

The API server uses hostname-based dispatch to route requests:

- **`localhost:8080`** / default → Main HMLS API (estimates, portal, admin, chat)
- **`fixo.localhost:8080`** / `api.fixo.hmls.autos` → Fixo API (sessions, billing, vehicles, chat)

Each sub-app has its own CORS, auth middleware, and error handler. No middleware leaks between
domains.

- **Web → Agent**: AI SDK v6 `useChat` with `DefaultChatTransport` (port 8080)
- **Fixo Web → Agent**: AI SDK v6 via `http://fixo.localhost:8080` / `https://api.fixo.hmls.autos`
- **Agent → DB**: Direct Supabase PostgreSQL connection via Drizzle ORM

### Key Patterns

**Shared Package** (`packages/shared/`): `@hmls/shared` with sub-path exports

- `@hmls/shared/errors` - AppError class, ErrorCode enum, Errors factories
- `@hmls/shared/tool-result` - MCP-compliant tool result helper
- `@hmls/shared/db` - Schema-agnostic `createDbClient(schema)` factory

**Gateway Routes** (`apps/gateway/src/routes/`): Hono sub-routers mounted by `hmls-app.ts`

- `chat.ts` / `staff-chat.ts` - AG-UI streaming endpoints (customer + admin)
- `orders.ts` - admin order CRUD + status transitions + `POST /:id/payment` (manual mark-paid)
- `portal.ts` - customer-facing order/booking endpoints
- `admin.ts` - dashboard, customers, bookings CRUD
- `admin-mechanics.ts` - mechanic management + booking reassignment
- `mechanic.ts` - mechanic self-service (availability, time-off)
- `estimates.ts` - public PDF route (reads orders now; legacy `estimates` table unused)
- `webhook.ts` - Stripe webhook (invoice.paid / payment_intent.succeeded only — quote handlers
  removed)
- `fixo/` - Fixo sub-app routes

**Deleted recently** (2026-04-20): legacy `/admin/estimates`, `/admin/quotes` CRUD routes;
customer-side `/preauth`, `/confirm-preauth`; admin-side `/capture`; Stripe `quote.accepted`
webhook. `apps/agent/src/hmls/tools/stripe.ts` (dead `create_quote` tool) deleted.

**Gateway Middleware** (`apps/gateway/src/middleware/`): Auth + admin middleware

- `auth.ts` - HMLS: requireAuth, optionalAuth
- `admin.ts` - Admin role check
- `fixo/` - Fixo-specific auth, credits, tier

**Agent Package** (`apps/agent/`): `@hmls/agent` with sub-path exports

- `@hmls/agent` → Agent factories, types, fixo lib, notifications, PDF components
- `@hmls/agent/db` → Drizzle DB client + schema

**HMLS Agent** (`apps/agent/src/hmls/`): Gemini 3 Flash Preview

- `agent.ts` - runHmlsAgent() — customer-facing (no stripe tools, scoped customer-order actions)
- `staff-agent.ts` - runStaffAgent() — admin-facing (includes adminOrderTools: create_order,
  find_customer, list_orders)
- `tools/` - scheduling, labor-lookup, parts-lookup, ask-user-question, admin-order-tools,
  customer-order-actions, customer-booking-actions, order-ops
- `skills/estimate/` - Pricing engine (OLP labor + parts + fees + discount). Source-tree dir name
  kept; the agent-facing skill markdown lives at `.skills/order/`.
- `common/tools/order.ts` - **`create_order`** tool — single entry point for all order writes.
  Modes: INSERT (no `orderId`) or UPDATE-in-place (with `orderId`). Full pricing engine. Updating an
  `estimated` order auto-flips it back to `revised`.
  - Customer agent: `customerId` resolved from auth context (ctx.customerId), not AI-supplied
  - Staff agent: AI passes `customerId` for known customers, or `customerInfo` for walk-in
    find-or-create

### Agent flow (customer chat)

1. Customer enters `/chat` (login required)
2. AI collects vehicle, symptoms; calls `lookup_labor_time` + `create_order`
3. Order lands as `orders` row with status=`draft`, `pendingReview: true` returned in tool result
4. If customer revises in same conversation, agent re-calls `create_order` with the same `orderId` —
   UPDATEs in place, no duplicate draft
5. Customer sees EstimateCard with "Pending review" badge (not "Not saved")
6. Admin reviews in `/admin/orders?status=draft` and clicks "Send to customer" → status=`estimated`
7. Customer approves in `/portal/orders/:id` → status=`approved`
8. Admin assigns mechanic + confirms booking in order detail page → status=`scheduled`

### Agent flow (admin walk-in)

Admin opens `/admin/chat` → tells staff agent ("create order for John, 2020 Civic, oil change") →
staff agent calls `search_customers` + `create_order` (passing `customerId` or `customerInfo`).
Subsequent revisions in the same chat re-call `create_order` with the captured `orderId`.

**Fixo Agent** (`apps/agent/src/fixo/`): Zypher + Gemini 2.5 Flash

- `agent.ts` - createFixoAgent() factory
- `tools/` - Vision analysis, audio spectrogram, OBD lookup, storage
- `lib/` - Stripe credits, Supabase storage, agent cache
- `pdf/fixo-report.tsx` - React-PDF fixo report

**Database Schema** (`apps/agent/src/db/schema.ts`): Drizzle ORM

- `orders` — **single source of truth** for the work lifecycle
  - Lifecycle: `status`, `statusHistory`, `revisionNumber`, `cancellationReason`
  - Content: `items` (jsonb), `notes`, `adminNotes`, `subtotalCents`, `priceRangeLow/HighCents`
  - Vehicle + symptoms: `vehicleInfo`, `symptomDescription`, `photoUrls`, `customerNotes`
  - Contact snapshot: `contactName/Email/Phone/Address`
  - Scheduling: `scheduledAt`, `appointmentEnd`, `durationMinutes`, `providerId`, `location`,
    `locationLat/Lng`, `accessInstructions`, `blockedRange` (tstzrange, auto-computed by trigger)
  - Sharing: `shareToken`, `validDays`, `expiresAt`
  - Payment: `paidAt`, `paymentMethod`, `paymentReference`, `capturedAmountCents`
- `order_events` — audit log (fromStatus, toStatus, actor, metadata)
- `customers`, `shops` (multi-tenant foundation, not yet enforced), `providers` (mechanics),
  `providerAvailability`, `providerScheduleOverrides`
- `pricingConfig` for dynamic pricing config
- `olpVehicles` / `olpLaborTimes` for OLP labor reference data
- `userProfiles` / `vehicles` / `fixoSessions` / `fixoMedia` / `obdCodes` / `fixoEstimates` for fixo
- **Dropped (Layer 3)**: `estimates`, `quotes`, `bookings` tables all removed. Booking data is now
  part of the order row.

### Migrations

- `0001-0006` - Orders lifecycle, contact snapshot, RBAC hook, etc.
- `0007` - Fix `compute_blocked_range` trigger (was referencing non-existent
  `buffer_before/after_minutes` cols)
- `0008` - Simplify status machine (13→9 states): drop preauth/invoiced/paid/archived/void; add
  paid_at/payment_method/payment_reference
- `0009` - Layer 3 PR A: orders absorbs booking scheduling fields; move `compute_blocked_range`
  trigger from bookings to orders; backfill linked bookings
- `0010` - Layer 3 PR C: drop `bookings`, `estimates`, `quotes` tables; drop orders legacy FK
  columns (estimate_id, quote_id, booking_id, stripe_quote_id, stripe_invoice_id,
  stripe_payment_intent_id, preauth_amount_cents)
- `0018` - Schema invariants: enums for status/event_type/payment_method/role; share_token UNIQUE;
  provider_availability EXCLUDE no-overlap; provider_schedule_overrides UNIQUE; trigger
  IS-DISTINCT-FROM short-circuit; drop dead
  `providers.specialties/service_radius_miles/home_base_*`; rename `captured_amount_cents` →
  `paid_amount_cents`
- `0019` - Layer 4 PR A: extract `order_intake` (1:1 child of orders, PK=order_id, ON DELETE
  CASCADE). Holds `symptom_description`, `photo_urls`, `customer_notes` — exists iff customer
  submitted intake via chat. Walk-in / direct admin orders have NO row.
- `0020` - Lock `orders.customer_id` to NOT NULL; backfill 8 orphan dev rows to a "Walk-in
  (unlinked)" placeholder customer (email `walkin-unlinked@hmls.local`)

## Pre-Push CI

**Always run the full CI suite locally before pushing:**

```bash
cd apps/hmls-web && bun run lint        # Biome lint
cd apps/hmls-web && bun run typecheck   # TypeScript check
cd apps/hmls-web && bun run build       # Next.js build
deno task check                    # Deno check gateway + agent
```

Do not push if any of these fail.

## Code Style

- **Web**: Biome (double quotes, 2-space indent)
- **Deno apps**: `deno fmt` (double quotes, 2-space indent, 100 char line width) + `deno lint`
- **TypeScript**: Strict mode across all packages
- **Commits**: Conventional format - `feat(scope): description`

## Updating Dependencies

```bash
# Deno apps — update versions in deno.json, then:
deno install

# Web app
cd apps/hmls-web && bunx npm-check-updates -u && bun install
```

## Environment Variables

Required in `.env`:

```
DATABASE_URL=postgres://postgres.[ref]:[password]@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
GOOGLE_API_KEY=...              # Google AI Studio key for Gemini 2.5 Flash
STRIPE_SECRET_KEY=sk_test_...
SUPABASE_URL=...                # Supabase project URL
SUPABASE_ANON_KEY=...           # Supabase anon key
SUPABASE_SERVICE_ROLE_KEY=...   # Supabase service role key (fixo media storage)
```

Optional in web (`.env.local`):

```
NEXT_PUBLIC_AGENT_URL=http://localhost:8080  # defaults to localhost:8080
```

## Deno Deploy CLI

Use `deno deploy` (NOT `deployctl` — deprecated):

```bash
# Environment variables
deno deploy env list --app hmls-api --org spinsirr
deno deploy env add <KEY> <VALUE> --app hmls-api --org spinsirr --secret
deno deploy env delete <KEY> --app hmls-api --org spinsirr
```

## Deployment & Domains

### Production URLs

| App               | Domain                               | Hosting                                                                  |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| Web (HMLS)        | `https://hmls.autos`                 | Deno Deploy                                                              |
| API (main + fixo) | `https://api.fixo.hmls.autos` (fixo) | Deno Deploy (`hmls-api`)                                                 |
| Fixo Web          | `https://fixo.ink`                   | Vercel (`prj_EzagTZlxfjG6U6h3Cbdt8uWjPwdO`, scope: `spinsirrs-projects`) |

Both main API and Fixo API run in the same Deno Deploy app (`hmls-api`), routed by hostname.

### Cloudflare DNS (zone: `hmls.autos`)

| Type  | Name       | Target              | Proxy                 |
| ----- | ---------- | ------------------- | --------------------- |
| CNAME | `api.fixo` | `hmls-api.deno.dev` | DNS only (gray cloud) |

(`fixo.ink` is its own zone, registered to the team — not managed in this Cloudflare zone.)

### Supabase Auth (project: `ddkapmjkubklyzuciscd`)

**URL Configuration** (Dashboard > Authentication > URL Configuration):

- **Site URL**: `https://hmls.autos`
- **Redirect URLs**:
  - `https://hmls.autos`
  - `http://localhost:3000`
  - `https://fixo.ink/**`
  - `http://localhost:3001/**` (fixo local dev)

### Vercel Environment Variables (fixo-web)

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL --scope spinsirrs-projects
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY --scope spinsirrs-projects
vercel env add NEXT_PUBLIC_AGENT_URL --scope spinsirrs-projects  # https://api.fixo.hmls.autos
```

## Recent session summary (2026-04-20)

- **Layer 1 done**: status machine simplified from 13→9 states. Migration `0008` remaps legacy data.
  New `paid_at` / `payment_method` / `payment_reference` columns added. `/capture`, `/preauth`,
  `/confirm-preauth` routes deleted.
- **Layer 2 done**: admin UI consolidated. Dashboard shows order-based stats. `/admin/schedule`
  deleted — Assign/Confirm/Reject actions migrated into order detail page BookingPanel.
  `/admin/estimates` and `/admin/quotes` admin routes deleted.
- **Layer 3 done**: orders absorbed bookings. Migrations `0009` (add scheduling columns + trigger +
  backfill) and `0010` (drop bookings/estimates/quotes + legacy FK columns) applied. All code paths
  read/write `orders` directly. `notifyBookingStatusChange` removed; mechanic's confirm/reject
  booking flow removed (admin does it via order status transitions). Customer cancel-booking is now
  an order-level action (`scheduled → cancelled`). Stripe webhook is now a no-op (dormant).
- **Agent UX hardened**: EstimateCard shows "Pending review" badge when order is draft.
  `create_order` pulls customerId from auth context for customer chat; staff agent passes
  `customerId` or `customerInfo` for walk-ins. SlotPicker is date + time dropdowns, orders created
  unassigned (admin dispatches).
- **Order tool unification (2026-04-23)**: `create_estimate` and the old `create_order` collapsed
  into a single `create_order` ([common/tools/order.ts](apps/agent/src/common/tools/order.ts)).
  INSERT (no orderId) or UPDATE-in-place (with orderId). Eliminates "agent creates a new draft every
  time the customer revises" duplication. `update_order_items`/`update_order` retained for cheap
  incremental patches. `.skills/estimate/` renamed to `.skills/order/`.
- **Known deferred**: Multi-shop tenancy — `shops` table exists but no code path scopes by `shop_id`
  yet. BAR § 3353 compliance flow — design in the air, not implemented. Stripe auto- capture is
  dormant — needs re-implementation if a shop opts in (add payment columns back selectively, wire
  webhook handlers).

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt,
invoke the skill.

Key routing rules:

- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
