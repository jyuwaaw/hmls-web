// apps/agent/src/fixo/tools/system-isolation.ts
//
// `isolate_systems` — given a symptom description and any DTCs, return a
// ranked list of candidate vehicle systems to investigate. This is step 5
// of the shop diagnostic flow (System Isolation). Static rule-based mapping
// for now — covers the common 80% of customer concerns. Output is meant to
// seed the agent's `candidateSystems` field on diagnostic state, which it
// then refines as evidence comes in.

import { z } from "zod";
import { toolResult } from "@hmls/shared/tool-result";

const symptomToSystems: Array<{
  keywords: string[];
  systems: Array<{ system: string; confidence: 1 | 2 | 3; reason: string }>;
}> = [
  // ----- Starting issues ------------------------------------------------
  {
    keywords: ["no crank", "no start", "won't start", "doesn't start", "click", "clicks", "dead"],
    systems: [
      {
        system: "battery",
        confidence: 3,
        reason: "no-crank symptoms most often weak/dead battery",
      },
      { system: "starter", confidence: 2, reason: "click without crank suggests starter solenoid" },
      { system: "ignition switch", confidence: 1, reason: "older vehicles: switch contacts" },
      { system: "anti-theft / immobilizer", confidence: 1, reason: "security light on at attempt" },
    ],
  },
  {
    keywords: ["cranks no start", "cranks but won't start", "won't catch", "won't fire"],
    systems: [
      { system: "fuel", confidence: 3, reason: "no fuel pressure prevents combustion" },
      { system: "ignition", confidence: 3, reason: "no spark prevents combustion" },
      { system: "compression", confidence: 2, reason: "timing belt/chain failure or jumped tooth" },
      {
        system: "sensors (CKP/CMP)",
        confidence: 2,
        reason: "ECM needs crank/cam signal to fire injectors",
      },
    ],
  },
  {
    keywords: ["hard start", "long crank", "takes a while to start"],
    systems: [
      { system: "fuel", confidence: 3, reason: "weak pump or leaking injector loses prime" },
      { system: "ignition", confidence: 2, reason: "worn plugs / coils need extra cranking" },
      { system: "battery", confidence: 1, reason: "weak battery extends crank time" },
    ],
  },

  // ----- Idle / running ------------------------------------------------
  {
    keywords: ["rough idle", "shaky idle", "stalls at idle", "idle surge", "hunting idle"],
    systems: [
      { system: "ignition", confidence: 3, reason: "misfires show up worst at idle" },
      { system: "vacuum / intake", confidence: 3, reason: "vacuum leaks cause idle instability" },
      { system: "fuel", confidence: 2, reason: "dirty injectors + bad fuel trim" },
      { system: "engine mounts", confidence: 1, reason: "broken mounts amplify vibration at idle" },
    ],
  },
  {
    keywords: ["misfire", "engine shake", "stumble", "hesitation", "bucking"],
    systems: [
      { system: "ignition", confidence: 3, reason: "spark plugs / coils are #1 misfire cause" },
      { system: "fuel", confidence: 2, reason: "dirty injectors / weak pump" },
      {
        system: "compression",
        confidence: 2,
        reason: "head gasket / valve issues on persistent single-cyl misfire",
      },
    ],
  },
  {
    keywords: ["check engine light", "cel", "engine light"],
    systems: [
      {
        system: "scan tool required",
        confidence: 3,
        reason: "pull DTCs first — system depends entirely on the code",
      },
    ],
  },

  // ----- Brakes ---------------------------------------------------------
  {
    keywords: ["brake noise", "brake squeal", "brake squeak", "grinding when braking", "screech"],
    systems: [
      { system: "brake pads", confidence: 3, reason: "wear indicators or worn-through pads" },
      { system: "rotors", confidence: 2, reason: "scoring / glazing / warped rotors" },
      { system: "calipers", confidence: 1, reason: "stuck slide pins cause uneven pad wear" },
    ],
  },
  {
    keywords: [
      "brake vibration",
      "shaking when braking",
      "pedal pulsation",
      "steering wheel shakes brake",
    ],
    systems: [
      { system: "rotors (warped)", confidence: 3, reason: "thickness variation causes pulsation" },
      { system: "wheel bearing", confidence: 1, reason: "play makes rotor wobble feel like warp" },
    ],
  },
  {
    keywords: ["soft brake pedal", "spongy pedal", "pedal goes to floor"],
    systems: [
      {
        system: "brake fluid (air or low)",
        confidence: 3,
        reason: "air in lines or fluid loss = soft pedal",
      },
      { system: "master cylinder", confidence: 2, reason: "internal seal bypass" },
      { system: "brake lines", confidence: 1, reason: "swollen rubber hose or leak" },
    ],
  },

  // ----- Highway / steering ---------------------------------------------
  {
    keywords: ["shake at highway", "vibrates over 60", "shake at speed", "steering shake highway"],
    systems: [
      { system: "tire balance", confidence: 3, reason: "out-of-balance tires shake at speed" },
      { system: "wheel bearing", confidence: 2, reason: "humming/wobble at speed" },
      { system: "alignment", confidence: 1, reason: "tire wear causes shake when worn" },
      { system: "driveshaft / axle", confidence: 1, reason: "RWD/AWD: worn u-joints or CV" },
    ],
  },
  {
    keywords: ["pulls left", "pulls right", "drifts left", "drifts right", "wanders"],
    systems: [
      { system: "alignment", confidence: 3, reason: "toe/camber out-of-spec causes pull" },
      { system: "tire pressure", confidence: 2, reason: "uneven inflation pulls car" },
      { system: "tire wear", confidence: 1, reason: "uneven wear creates pull" },
      { system: "brakes (sticking caliper)", confidence: 1, reason: "drag on one side pulls" },
    ],
  },

  // ----- Cooling / overheating ------------------------------------------
  {
    keywords: ["overheat", "running hot", "temp gauge high", "coolant boiling", "steam"],
    systems: [
      {
        system: "coolant level / leak",
        confidence: 3,
        reason: "low coolant first — visual + pressure test",
      },
      { system: "thermostat", confidence: 2, reason: "stuck-closed thermostat = no flow" },
      { system: "water pump", confidence: 2, reason: "weeping pump or impeller failure" },
      { system: "radiator fan", confidence: 2, reason: "fan not engaging at temp" },
      { system: "head gasket", confidence: 1, reason: "block test if combustion gases in coolant" },
    ],
  },

  // ----- Climate --------------------------------------------------------
  {
    keywords: ["ac not cold", "ac warm", "no cold air", "weak ac"],
    systems: [
      { system: "refrigerant level", confidence: 3, reason: "low charge from leak" },
      {
        system: "compressor clutch",
        confidence: 2,
        reason: "not engaging — electrical or low-pressure cutoff",
      },
      {
        system: "condenser",
        confidence: 1,
        reason: "blocked condenser fins or fan not pulling air",
      },
      { system: "blend door / cabin", confidence: 1, reason: "actuator stuck on heat" },
    ],
  },

  // ----- Transmission ---------------------------------------------------
  {
    keywords: [
      "jerky shift",
      "harsh shift",
      "slips",
      "slipping",
      "shudder",
      "transmission shudder",
    ],
    systems: [
      { system: "transmission fluid", confidence: 3, reason: "low or burnt fluid #1 cause" },
      { system: "torque converter", confidence: 2, reason: "lockup shudder is classic TCC" },
      { system: "solenoids / TCM", confidence: 2, reason: "solenoid wear or TCM mapping" },
      { system: "engine mounts", confidence: 1, reason: "broken mounts amplify shift jolts" },
    ],
  },

  // ----- Leaks / smoke --------------------------------------------------
  {
    keywords: ["oil leak", "leaking oil", "oil spot", "puddle"],
    systems: [
      { system: "valve cover gasket", confidence: 2, reason: "common leak point on aging engines" },
      { system: "oil pan gasket", confidence: 2, reason: "common leak point" },
      { system: "rear main seal", confidence: 1, reason: "behind flywheel — labor-heavy" },
      { system: "transmission seals", confidence: 1, reason: "rule out trans fluid (red/pink)" },
    ],
  },
  {
    keywords: ["blue smoke", "burning oil"],
    systems: [
      { system: "valve seals", confidence: 3, reason: "blue smoke at startup = valve seals" },
      { system: "piston rings", confidence: 2, reason: "blue smoke under load = ring wear" },
      { system: "PCV system", confidence: 1, reason: "stuck PCV pulls oil into intake" },
    ],
  },
  {
    keywords: ["white smoke", "steam from exhaust"],
    systems: [
      { system: "head gasket", confidence: 3, reason: "white smoke + sweet smell = coolant burn" },
      { system: "cracked head", confidence: 2, reason: "block test confirms" },
      {
        system: "intake manifold gasket",
        confidence: 1,
        reason: "some engines leak coolant intake",
      },
    ],
  },
  {
    keywords: ["black smoke"],
    systems: [
      { system: "fuel (running rich)", confidence: 3, reason: "leaking injector or bad MAF" },
      { system: "air filter", confidence: 1, reason: "severely clogged filter" },
    ],
  },
];

// Map DTC `system` labels (returned by lookupObdCode) to canonical isolation
// candidate systems. Lets the agent feed DTC results straight in and get
// confidence-3 candidates back.
const dtcSystemMap: Record<string, string[]> = {
  Ignition: ["ignition", "compression"],
  Fuel: ["fuel", "vacuum / intake"],
  Emissions: ["emissions / catalyst", "fuel"],
  EVAP: ["evap"],
  Timing: ["timing (vvt / chain)"],
  Cooling: ["coolant level / leak", "thermostat"],
  Transmission: ["transmission fluid", "solenoids / TCM"],
  Sensors: ["sensors (specific to code)"],
};

const isolateSchema = z.object({
  symptomDescription: z
    .string()
    .optional()
    .describe(
      "Free-form symptom description from the customer, e.g. 'engine shakes at idle and CEL is on'. " +
        "Tool keyword-matches against a shop knowledge base.",
    ),
  dtcSystems: z
    .array(z.string())
    .optional()
    .describe(
      "DTC `system` labels from lookupObdCode results, e.g. ['Ignition', 'Emissions']. " +
        "Each maps to high-confidence candidate systems.",
    ),
});

interface CandidateScore {
  system: string;
  confidence: 0 | 1 | 2 | 3;
  reasons: string[];
}

function isolateSystems(input: z.infer<typeof isolateSchema>): CandidateScore[] {
  const byName = new Map<string, CandidateScore>();

  // 1. Match symptom keywords
  if (input.symptomDescription) {
    const haystack = input.symptomDescription.toLowerCase();
    for (const rule of symptomToSystems) {
      const matched = rule.keywords.some((kw) => haystack.includes(kw));
      if (!matched) continue;
      for (const s of rule.systems) {
        const existing = byName.get(s.system);
        if (existing) {
          existing.confidence = Math.max(existing.confidence, s.confidence) as 0 | 1 | 2 | 3;
          if (!existing.reasons.includes(s.reason)) existing.reasons.push(s.reason);
        } else {
          byName.set(s.system, {
            system: s.system,
            confidence: s.confidence,
            reasons: [s.reason],
          });
        }
      }
    }
  }

  // 2. Map DTC systems
  for (const dtcSystem of input.dtcSystems ?? []) {
    const candidates = dtcSystemMap[dtcSystem] ?? [dtcSystem.toLowerCase()];
    for (const sys of candidates) {
      const existing = byName.get(sys);
      const reason = `DTC system '${dtcSystem}' present`;
      if (existing) {
        existing.confidence = 3;
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      } else {
        byName.set(sys, { system: sys, confidence: 3, reasons: [reason] });
      }
    }
  }

  return [...byName.values()].sort((a, b) => b.confidence - a.confidence);
}

export const isolateSystemsTool = {
  name: "isolate_systems",
  description: "Given the customer's symptom description and any DTC system labels, return " +
    "a ranked list of candidate vehicle systems to investigate next, with reasons. " +
    "This is the diagnostic 'where do we look' step — narrows from 'something is wrong' " +
    "to 'check these 2-3 systems first'. Use the result to seed candidateSystems " +
    "via update_diagnostic_state, then propose pinpoint tests via plan_pinpoint_tests.",
  schema: isolateSchema,
  // deno-lint-ignore require-await
  execute: async (params: z.infer<typeof isolateSchema>) => {
    const candidates = isolateSystems(params);
    return toolResult({
      candidates,
      note: candidates.length === 0
        ? "No keyword matches — ask the customer for more specific symptom details, or skip straight to DTC scan."
        : undefined,
    });
  },
};

// Export for test usage
export { isolateSystems };
