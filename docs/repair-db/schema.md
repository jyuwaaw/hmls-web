# HMLS Repair Database — Design (draft, 2026-06-14)

HMLS-owned repair dataset that powers AI estimates, **decoupled from OLP**. Bootstrapped from data
we already hold, hardened over time by real shop jobs (the moat).

## Bootstrap status (what we already have)

| Block                                                        | Status                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Job catalog** — 651 jobs, 23 categories (incl. 46 EV jobs) | ✅ exported → `job-catalog.json`                                     |
| **Labor seed** — 2,395,095 (vehicle × job) hours, 0 bad rows | ✅ already in D1 `olp-labor-times`                                   |
| Per-job **tools / difficulty**                               | ⚙️ gap — generate **once per job slug** (651×), join to all vehicles |
| **Real labor calibration** (moat)                            | 🔜 capture from completed `orders`                                   |
| Vehicle spine reconciled to NHTSA vPIC                       | 🔜                                                                   |

**Provenance note:** the 2.4M seed is OLP-origin. We treat it as an _estimated baseline_
(`source='seed'`), progressively overridden by our own real shop data → the dataset becomes
genuinely HMLS-owned over time. Do not resell the raw seed; OLP also sells a competing product.

## Tables

### `repair_jobs` — the catalog (vehicle-independent)

The 651-job backbone. One row per job; tools/difficulty are a function of the **job**, not the
vehicle.

```
slug            TEXT PK        -- e.g. "brake-pads-front"
name            TEXT
category        TEXT           -- 23 categories (brakes, engine, ev-battery, ...)
tools           JSONB          -- [{name, optional, specialty?}]  (generated per slug)
difficulty      SMALLINT       -- 1..5 (generated per slug)
typical_parts   JSONB          -- part categories needed (generated per slug)
notes           TEXT
```

### `repair_vehicles` — the spine (keys)

Sourced from NHTSA vPIC (free) + reconciled with the existing OLP vehicle rows.

```
id              SERIAL PK
make, make_slug, model, model_slug
year_start, year_end           -- OLP rows are ranges; vPIC is per-year — store both, query by overlap
engine, engine_slug, fuel_type, drivetrain
source          TEXT           -- 'vpic' | 'seed' | 'manual'
```

### `repair_labor` — (vehicle × job) hours ← the heart

```
vehicle_id      INT  FK repair_vehicles
job_slug        TEXT FK repair_jobs
hours           NUMERIC(5,2)
source          TEXT           -- 'seed' (OLP baseline) | 'real' (completed order) | 'manual'
confidence      TEXT           -- 'estimated' | 'observed'
sample_size     INT            -- # of real jobs averaged (source='real')
updated_at      TIMESTAMPTZ
PRIMARY KEY (vehicle_id, job_slug)
```

Seeded from the 2.4M rows as `source='seed', confidence='estimated'`. A completed order upserts
`source='real'` and wins over seed.

### Later: `repair_torque`, `repair_fluids`, `repair_dtc`

The existing OLP data and the live site also carry torque specs, fluid capacities, DTC codes. Same
shape (per vehicle/job). Defer to P4.

## Sourcing map

| Dimension                          | Source                                | Own it?   |
| ---------------------------------- | ------------------------------------- | --------- |
| Vehicle keys / VIN decode          | NHTSA vPIC (free)                     | use       |
| Job catalog (651)                  | extracted from existing data          | ✅        |
| Tools / difficulty / typical parts | AI-generate once per job slug (651×)  | ✅        |
| Labor baseline                     | existing 2.4M seed                    | ✅ (seed) |
| Labor truth                        | **completed HMLS orders**             | ✅ (moat) |
| Parts + live pricing               | PartsTech / Nexpart API at quote time | external  |

## Integration with the existing system

- The estimate engine today calls the OLP worker
  ([olp-client.ts](apps/agent/src/hmls/tools/olp-client.ts)). Swap that lookup for a query against
  `repair_labor` (seed) keyed by `(vehicle, job_slug)`.
- **Calibration loop:** when an `order` reaches `completed`, capture the actual labor hours per line
  item → upsert into `repair_labor` as `source='real'` (rolling average, bump `sample_size`). That
  (vehicle, job) baseline now reflects HMLS reality. This is the C-layer moat.

## Phased build

- **P1 (now):** ✅ job catalog → generate tools/difficulty for the 651 jobs → reconcile vehicle
  spine to vPIC → land `repair_jobs` + `repair_vehicles` + `repair_labor` (seeded).
- **P2:** serve estimates from `repair_labor` seed instead of the OLP worker.
- **P3:** calibration loop from completed orders (`source='real'`).
- **P4:** torque / fluids / DTC tables; parts pricing via PartsTech at quote time.

## Scope discipline

Don't replicate "every vehicle 1955+". Prioritize the vehicles HMLS shops actually service (US
market, ~2005+, mainstream makes). The vPIC spine makes adding a vehicle near-free, so grow from
real demand rather than upfront breadth.
