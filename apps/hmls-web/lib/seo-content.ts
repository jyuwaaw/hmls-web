/**
 * Programmatic SEO content for /areas/[city] and /services/[service].
 *
 * Each entry has unique 2-3 sentence prose so Google doesn't class the
 * pages as duplicate / doorway content. When you onboard a new city or
 * service, add an entry here — the dynamic route picks it up.
 *
 * Data shape is deliberately simple: slug + display name + 1-2 lines of
 * differentiated copy. Templated layout fills in the rest from BUSINESS.
 */

import type { RegionId } from "./business";

export type CitySlug =
  // Orange County
  | "irvine"
  | "newport-beach"
  | "costa-mesa"
  | "santa-ana"
  | "tustin"
  | "anaheim"
  | "orange"
  | "huntington-beach"
  | "fountain-valley"
  | "lake-forest"
  | "mission-viejo"
  | "aliso-viejo"
  | "laguna-hills"
  | "laguna-niguel"
  // San Jose / South Bay
  | "san-jose"
  | "santa-clara"
  | "sunnyvale"
  | "mountain-view"
  | "cupertino"
  | "campbell"
  | "milpitas"
  | "los-gatos"
  | "saratoga"
  | "morgan-hill";

export interface CityContent {
  slug: CitySlug;
  region: RegionId;
  name: string;
  /** Minutes from this city's *region* home base (Irvine for OC, San Jose for SJ). */
  driveMinutes: number;
  neighborhoods: string[];
  intro: string;
  callout: string;
}

const OC_CITIES: readonly Omit<CityContent, "region">[] = [
  {
    slug: "irvine",
    name: "Irvine",
    driveMinutes: 0,
    neighborhoods: [
      "Woodbridge",
      "Quail Hill",
      "Northwood",
      "Turtle Rock",
      "UCI",
    ],
    intro:
      "We’re based in Irvine, so service here usually means same-day availability — most jobs land in your driveway within an hour or two of booking. Apartment-complex parking lots and gated communities are no problem; we work in the spot you’re already parked.",
    callout:
      "Most popular: oil changes for tech-worker commuters and brake jobs on family SUVs.",
  },
  {
    slug: "newport-beach",
    name: "Newport Beach",
    driveMinutes: 12,
    neighborhoods: [
      "Balboa Peninsula",
      "Corona del Mar",
      "Newport Coast",
      "Fashion Island",
    ],
    intro:
      "Newport drivers tend to keep their cars longer and care about doing it right. We handle European luxury vehicles (BMW, Mercedes, Audi, Porsche) at independent-shop labor rates — no dealership markup, no waiting room.",
    callout:
      "Diagnostics + pre-purchase inspections are our most-requested Newport services.",
  },
  {
    slug: "costa-mesa",
    name: "Costa Mesa",
    driveMinutes: 10,
    neighborhoods: [
      "Mesa Verde",
      "Eastside",
      "South Coast Metro",
      "OC Fairgrounds",
    ],
    intro:
      "Costa Mesa’s mix of older homes with limited driveway space and the South Coast Metro condo lots is exactly where mobile service shines. We bring the lift to you — no need to find an open shop bay before work.",
    callout:
      "Common ask: brake repair and battery replacement before South Coast commute.",
  },
  {
    slug: "santa-ana",
    name: "Santa Ana",
    driveMinutes: 15,
    neighborhoods: [
      "Downtown Santa Ana",
      "Floral Park",
      "South Coast",
      "Civic Center",
    ],
    intro:
      "Santa Ana customers often just need a fast, honest estimate before paying a chain shop’s upsell. We’ll come, diagnose, quote at OLP labor pricing, and you decide — no obligation.",
    callout:
      "Free pre-purchase inspections are popular before private-party Santa Ana car deals.",
  },
  {
    slug: "tustin",
    name: "Tustin",
    driveMinutes: 8,
    neighborhoods: [
      "Old Town Tustin",
      "Tustin Ranch",
      "Tustin Legacy",
      "Columbus Square",
    ],
    intro:
      "Tustin is a 10-minute hop from our Irvine base, so booking windows here are tight — same-day morning slots are usually open. We do the full mobile-mechanic stack: oil, brakes, batteries, diagnostics, and OBD-II code work.",
    callout:
      "Ranch and Legacy residents lean into preventive maintenance — that’s our strong suit.",
  },
  {
    slug: "anaheim",
    name: "Anaheim",
    driveMinutes: 22,
    neighborhoods: [
      "Anaheim Hills",
      "Platinum Triangle",
      "Downtown Anaheim",
      "Disneyland Resort",
    ],
    intro:
      "Anaheim families lean on minivans and SUVs that rack up miles fast. We bring brake pads, fluids, and batteries to your home — most jobs done in the time it takes to grab a coffee.",
    callout:
      "Anaheim Hills serpentine roads chew through brake pads — we keep OE-grade pads on the truck.",
  },
  {
    slug: "orange",
    name: "Orange",
    driveMinutes: 18,
    neighborhoods: [
      "Old Towne Orange",
      "Orange Park Acres",
      "El Modena",
      "Chapman University",
    ],
    intro:
      "Old Towne’s narrow streets and historic neighborhoods don’t play nicely with tow trucks or big-box service centers. We park curbside, work clean, and leave no trace — perfect for HOA-conscious blocks.",
    callout:
      "Chapman students: pre-purchase inspections before you sign that off-campus car deal.",
  },
  {
    slug: "huntington-beach",
    name: "Huntington Beach",
    driveMinutes: 18,
    neighborhoods: [
      "Huntington Harbor",
      "Downtown HB",
      "Edinger Corridor",
      "Bella Terra",
    ],
    intro:
      "Salt air and beach driving accelerate corrosion on undercarriage components — brake calipers and rotors especially. We see Huntington Beach cars more often for brake work than any other reason.",
    callout:
      "Heads up: any brake squeal near the coast deserves an inspection before it becomes a rotor job.",
  },
  {
    slug: "fountain-valley",
    name: "Fountain Valley",
    driveMinutes: 15,
    neighborhoods: [
      "Mile Square",
      "Fountain Valley Civic Center",
      "South Mile Square",
    ],
    intro:
      "Fountain Valley is one of those quiet residential pockets that big chain shops underserve. Mobile service fills the gap — we cover oil changes, brake jobs, and diagnostics across both halves of the city.",
    callout:
      "Most asked: 60K / 90K mile maintenance services to dodge the dealership markup.",
  },
  {
    slug: "lake-forest",
    name: "Lake Forest",
    driveMinutes: 14,
    neighborhoods: [
      "Foothill Ranch",
      "Portola Hills",
      "El Toro",
      "Lake Forest II",
    ],
    intro:
      "Foothill Ranch and Portola Hills sit at altitude, which means harder starts in winter and more battery turnover. We carry AGM and standard batteries on the truck for same-visit replacement.",
    callout:
      "Cold-morning no-start? We do battery + alternator load testing at your driveway.",
  },
  {
    slug: "mission-viejo",
    name: "Mission Viejo",
    driveMinutes: 20,
    neighborhoods: [
      "Lake Mission Viejo",
      "Aurora Heights",
      "Madrid Fore",
      "Casta del Sol",
    ],
    intro:
      "Mission Viejo’s rolling-hills topography is rough on suspension and brakes — we see a lot of front-pad replacements and shock complaints. We’ll quote OE-grade parts only; no aftermarket roulette.",
    callout:
      "Common request: full brake job (pads + rotors) on Suburbans and Tahoes.",
  },
  {
    slug: "aliso-viejo",
    name: "Aliso Viejo",
    driveMinutes: 22,
    neighborhoods: ["Aliso Town Center", "Aliso Niguel", "Glenwood", "Liberty"],
    intro:
      "Aliso Viejo’s 91-degree summer commute melts cooling systems — radiator hoses, coolant, and AC compressors top our service log here. We bring refrigerant, hose stock, and OBD-II tools.",
    callout:
      "Summer heat soaks: AC diagnostics is the fastest-growing Aliso service line.",
  },
  {
    slug: "laguna-hills",
    name: "Laguna Hills",
    driveMinutes: 21,
    neighborhoods: [
      "Nellie Gail Ranch",
      "Laguna Hills Mall area",
      "Moulton Pkwy corridor",
    ],
    intro:
      "Laguna Hills sits between coastal salt air and inland heat, so we tune service recommendations to whichever exposure your car gets. Battery and brake work are the two most common asks.",
    callout:
      "Nellie Gail equestrian residents: we work fine on dirt driveways and graveled spaces.",
  },
  {
    slug: "laguna-niguel",
    name: "Laguna Niguel",
    driveMinutes: 24,
    neighborhoods: [
      "Crown Valley Pkwy",
      "Niguel Ranch",
      "Marina Hills",
      "Talavera",
    ],
    intro:
      "Laguna Niguel is the south end of our coverage — booking 24 hours ahead guarantees a slot. The 5-South commuter wear shows up in brakes, tires, and CV joints.",
    callout:
      "Frequent flyer: front-brake replacement on hybrid sedans (Prius, Camry hybrid, Insight).",
  },
];

const SJ_CITIES: readonly Omit<CityContent, "region">[] = [
  {
    slug: "san-jose",
    name: "San Jose",
    driveMinutes: 0,
    neighborhoods: [
      "Willow Glen",
      "Almaden Valley",
      "Evergreen",
      "Berryessa",
      "Japantown",
    ],
    intro:
      "We’re based in the South Bay, so San Jose is home turf — same-day driveway service from Willow Glen to Evergreen, and we’re used to apartment lots, townhome complexes, and tight downtown parking. Tell us where the car sits and we come to it.",
    callout:
      "Most common: brake jobs and oil changes for tech commuters racking up miles on the 101 and 280.",
  },
  {
    slug: "santa-clara",
    name: "Santa Clara",
    driveMinutes: 12,
    neighborhoods: [
      "Rivermark",
      "Old Quad",
      "Santa Clara University",
      "Mission College",
    ],
    intro:
      "Santa Clara runs on commuter cars and apartment parking — the Nvidia, Intel, and university crowd. We come to your complex or office lot, so you don’t burn a workday sitting in a shop.",
    callout:
      "Battery and brake work top the list along the 101 / Great America corridor.",
  },
  {
    slug: "sunnyvale",
    name: "Sunnyvale",
    driveMinutes: 15,
    neighborhoods: [
      "Downtown Sunnyvale",
      "Ponderosa Park",
      "Cherry Chase",
      "Lakewood",
    ],
    intro:
      "Sunnyvale’s dense apartment blocks and tech campuses are exactly where mobile service wins — we work in the spot your car is already parked, from Murphy Ave to the big campus lots.",
    callout:
      "High-mileage commuter maintenance (60k / 90k services) is the most-requested Sunnyvale job.",
  },
  {
    slug: "mountain-view",
    name: "Mountain View",
    driveMinutes: 20,
    neighborhoods: [
      "Castro Street",
      "Shoreline West",
      "Cuesta Park",
      "Whisman",
    ],
    intro:
      "Mountain View skews hybrid and EV-heavy — we handle 12V batteries, brakes, and accessory work on Priuses, Teslas, and everything between, right at your place near Shoreline or Castro.",
    callout:
      "Brake and battery service on hybrids is the bread and butter here.",
  },
  {
    slug: "cupertino",
    name: "Cupertino",
    driveMinutes: 18,
    neighborhoods: [
      "Rancho Rinconada",
      "Monta Vista",
      "Oak Valley",
      "near Apple Park",
    ],
    intro:
      "Cupertino drivers keep clean, well-kept cars and care about doing it right — we service European and Japanese makes at independent-shop labor rates, no dealership markup, in your driveway.",
    callout:
      "Pre-purchase inspections and scheduled maintenance lead the Cupertino mix.",
  },
  {
    slug: "campbell",
    name: "Campbell",
    driveMinutes: 12,
    neighborhoods: ["Downtown Campbell", "Pruneyard", "San Tomas", "Cambrian"],
    intro:
      "Campbell’s mix of older homes and downtown apartments is ideal for mobile work — curbside or in the lot off the Pruneyard, we keep it clean and leave no trace.",
    callout:
      "Brakes, batteries, and diagnostics before the daily 17 / 85 commute.",
  },
  {
    slug: "milpitas",
    name: "Milpitas",
    driveMinutes: 15,
    neighborhoods: [
      "McCarthy Ranch",
      "Sandalwood",
      "Midtown",
      "Great Mall area",
    ],
    intro:
      "Milpitas commuters lean on the 880 and 237 and rack up miles fast — we bring fluids, pads, and batteries to your home or near the Great Mall so you’re not stuck waiting at a shop.",
    callout:
      "High-mileage maintenance and brake jobs are the most common Milpitas asks.",
  },
  {
    slug: "los-gatos",
    name: "Los Gatos",
    driveMinutes: 20,
    neighborhoods: [
      "Downtown Los Gatos",
      "Monte Sereno",
      "Blossom Hill",
      "Vasona",
    ],
    intro:
      "Los Gatos drivers tend to keep their cars longer and own more European luxury — BMW, Mercedes, Audi, Porsche. We handle them at independent labor rates, at your home in the hills or downtown.",
    callout:
      "Diagnostics and luxury-make maintenance are the most-requested Los Gatos services.",
  },
  {
    slug: "saratoga",
    name: "Saratoga",
    driveMinutes: 22,
    neighborhoods: [
      "Downtown Saratoga",
      "Argonaut",
      "Quito",
      "Congress Springs",
    ],
    intro:
      "Saratoga’s hillside homes and winding roads are tough on brakes and suspension — we bring OE-grade parts and do the work in your driveway, no trip down the hill required.",
    callout:
      "Front-brake and suspension work show up most on Saratoga’s hill routes.",
  },
  {
    slug: "morgan-hill",
    name: "Morgan Hill",
    driveMinutes: 30,
    neighborhoods: [
      "Downtown Morgan Hill",
      "Jackson Oaks",
      "Paradise Valley",
      "Nordstrom",
    ],
    intro:
      "Morgan Hill sits at the south end of our South Bay coverage — book a day ahead and we come to you. The 101 commute wear shows up in brakes, tires, and batteries.",
    callout:
      "Commuter brake and battery service is the frequent Morgan Hill request.",
  },
];

export const CITIES: readonly CityContent[] = [
  ...OC_CITIES.map((c) => ({ ...c, region: "oc" as RegionId })),
  ...SJ_CITIES.map((c) => ({ ...c, region: "sj" as RegionId })),
];

export function findCity(slug: string): CityContent | undefined {
  return CITIES.find((c) => c.slug === slug);
}

export type ServiceSlug =
  | "oil-change"
  | "brake-repair"
  | "battery-replacement"
  | "diagnostics"
  | "pre-purchase-inspection";

export interface ServiceContent {
  slug: ServiceSlug;
  name: string;
  shortName: string;
  intro: string;
  whatWeDo: string[];
  signsYouNeedIt: string[];
  typicalDuration: string;
  estimatedRange: string;
}

export const SERVICES: readonly ServiceContent[] = [
  {
    slug: "oil-change",
    name: "Mobile Oil Change",
    shortName: "Oil Change",
    intro:
      "Synthetic, blend, or conventional — we bring the oil and filter to your driveway and recycle the old fluid responsibly. Most oil changes take 25–40 minutes, and we never push a service interval you don’t need.",
    whatWeDo: [
      "Drain old oil into a sealed catch container (zero driveway mess)",
      "Replace OEM-spec filter (we stock Mahle, Mann, Wix)",
      "Refill with manufacturer-spec oil (5W-20, 5W-30, 0W-20, etc.)",
      "Reset the maintenance reminder light",
      "Check tire pressure and top off washer fluid",
    ],
    signsYouNeedIt: [
      "Maintenance light is on",
      "Oil life monitor reads under 15%",
      "It’s been more than 5,000 miles since the last change",
      "Oil on the dipstick looks dark and gritty",
    ],
    typicalDuration: "25–40 minutes",
    estimatedRange: "$60–$120 depending on oil type and capacity",
  },
  {
    slug: "brake-repair",
    name: "Mobile Brake Repair",
    shortName: "Brake Repair",
    intro:
      "Pads, rotors, calipers, fluid — we handle the full brake stack mobile. We use OE-grade pads (Akebono, Bosch, Wagner) and resurface or replace rotors based on measured wear, not eyeballing.",
    whatWeDo: [
      "Inspect pads, rotors, calipers, hoses, and brake fluid condition",
      "Measure rotor thickness with a micrometer (no guessing)",
      "Replace pads + resurface or swap rotors as needed",
      "Bleed brake fluid if old or contaminated",
      "Test-drive to verify pedal feel and braking distance",
    ],
    signsYouNeedIt: [
      "Squealing or grinding when braking",
      "Steering wheel vibrates under hard braking",
      "Brake pedal feels soft or sinks to the floor",
      "Brake warning light on the dash",
    ],
    typicalDuration: "60–120 minutes per axle",
    estimatedRange: "$180–$450 per axle (parts + labor)",
  },
  {
    slug: "battery-replacement",
    name: "Mobile Battery Replacement",
    shortName: "Battery Replacement",
    intro:
      "Dead battery in the morning? We carry AGM, EFB, and standard batteries on the truck for most makes. We test before replacing — sometimes the alternator is the real culprit, and we’ll save you the parts cost.",
    whatWeDo: [
      "Load test the existing battery and alternator",
      "Replace the battery with a matching group-size, CCA-rated unit",
      "Reprogram the BMS / register the new battery (BMW, Audi, Mercedes)",
      "Recycle the old battery (no core fee)",
      "Verify clean cranking voltage on cold start",
    ],
    signsYouNeedIt: [
      "Slow cranking on cold mornings",
      "Battery warning light on the dash",
      "Check engine light from low voltage",
      "Battery is more than 4 years old",
    ],
    typicalDuration: "30–60 minutes",
    estimatedRange: "$180–$320 depending on battery type",
  },
  {
    slug: "diagnostics",
    name: "Mobile Diagnostics",
    shortName: "Diagnostics",
    intro:
      "Check engine light, weird noise, mystery fault — we bring full OBD-II scanners (Autel, Snap-On) to read live data and pinpoint root cause. No more “just clear it and see if it comes back” from chain shops.",
    whatWeDo: [
      "Pull OBD-II codes (current and pending)",
      "Read live data: O2 sensors, fuel trims, misfire counts, MAF flow",
      "Inspect the relevant subsystem (vacuum lines, sensors, harness)",
      "Provide a written diagnosis with repair quote — no surprises",
      "If you decide not to repair, the diagnostic fee is yours to keep",
    ],
    signsYouNeedIt: [
      "Check engine light is on (solid or flashing)",
      "Car running rough, hesitating, or stalling",
      "Sudden drop in MPG",
      "Unusual noise, smell, or vibration",
    ],
    typicalDuration: "45–90 minutes",
    estimatedRange: "$95 flat diagnostic fee, applied to repair if you book",
  },
  {
    slug: "pre-purchase-inspection",
    name: "Pre-Purchase Inspection",
    shortName: "Pre-Purchase Inspection",
    intro:
      "Buying a used car? We meet you at the seller’s location, run a full inspection, and give you written findings before you wire money. One missed problem can cost more than the inspection 10x over.",
    whatWeDo: [
      "Cold-start verification + listening test for engine knock or tick",
      "OBD-II scan: confirm no hidden codes were cleared by the seller",
      "Visual check: leaks, corrosion, prior collision evidence",
      "Test drive: brakes, steering, transmission shift quality",
      "Written report with photos — yours to use as negotiation leverage",
    ],
    signsYouNeedIt: [
      "About to buy a used car private-party or dealer-as-is",
      "Sub-$15K vehicle where a hidden $3K issue would kill the deal",
      "Out-of-state purchase you can’t inspect yourself",
      "Specialty / luxury vehicle you don’t know intimately",
    ],
    typicalDuration: "60–90 minutes on-site",
    estimatedRange: "$150–$200 flat, includes written report",
  },
] as const;

export function findService(slug: string): ServiceContent | undefined {
  return SERVICES.find((s) => s.slug === slug);
}
