// apps/agent/src/fixo/tools/pinpoint-test-plan.ts
//
// `plan_pinpoint_tests` — given a candidate vehicle system, return an ordered
// list of physical tests a tech (or a customer with a code reader + a few
// minutes) can run to confirm the actual fault. This is step 6 of the shop
// diagnostic flow (Pinpoint Test). Use when the agent has narrowed down the
// system but doesn't yet have the root cause.

import { z } from "zod";
import { toolResult } from "@hmls/shared/tool-result";

interface PinpointTest {
  test: string;
  /** Approximate cost level: cheap (DIY/free), medium (basic shop tools), expensive (specialist tools / labor). */
  cost: "cheap" | "medium" | "expensive";
  /** What a positive result rules in or out. */
  reads: string;
}

// Tests are ordered cheapest → most invasive within each system. The agent
// should walk down the list, recording results via update_diagnostic_state,
// until it has enough evidence to set rootCause.
const TESTS_BY_SYSTEM: Record<string, PinpointTest[]> = {
  battery: [
    {
      test: "voltage at rest (12.6V healthy, <12.4V suspect)",
      cost: "cheap",
      reads: "state of charge",
    },
    {
      test: "load test (drops below 9.6V under load = bad)",
      cost: "cheap",
      reads: "battery health under draw",
    },
    {
      test: "voltage drop on cables (>0.2V on either side = corrosion)",
      cost: "cheap",
      reads: "cable / terminal resistance",
    },
    {
      test: "alternator charging test (13.8–14.7V at idle)",
      cost: "cheap",
      reads: "alternator output",
    },
  ],
  starter: [
    {
      test: "voltage at starter S-terminal during crank (should be ~12V)",
      cost: "cheap",
      reads: "command signal reaches starter",
    },
    {
      test: "voltage drop across battery cables during crank (<0.5V each)",
      cost: "cheap",
      reads: "cable resistance under load",
    },
    {
      test: "current draw during crank (compare to spec)",
      cost: "medium",
      reads: "starter motor health",
    },
  ],
  fuel: [
    {
      test: "fuel pressure key-on engine-off vs spec",
      cost: "medium",
      reads: "pump prime + regulator",
    },
    {
      test: "fuel pressure running at idle vs spec",
      cost: "medium",
      reads: "pump under load + regulator",
    },
    {
      test: "fuel pressure during snap-throttle (should jump 5-8 psi)",
      cost: "medium",
      reads: "pump max output",
    },
    {
      test: "fuel pressure key-off bleed-down (should hold 30+ min)",
      cost: "medium",
      reads: "leaking injector / regulator",
    },
    {
      test: "injector balance test (scan tool actuator)",
      cost: "medium",
      reads: "per-injector flow",
    },
    { test: "fuel sample for water/contamination", cost: "cheap", reads: "fuel quality" },
  ],
  ignition: [
    {
      test: "remove + inspect spark plugs (color, gap, wear)",
      cost: "cheap",
      reads: "running condition + wear",
    },
    {
      test: "swap suspect coil to a known-good cylinder, recheck misfire counter",
      cost: "cheap",
      reads: "isolates coil vs cylinder",
    },
    {
      test: "scope ignition primary or secondary waveform",
      cost: "expensive",
      reads: "coil + wire health under load",
    },
    {
      test: "ignition timing check at idle (if base-timing adjustable)",
      cost: "medium",
      reads: "timing / sensor reference",
    },
  ],
  "vacuum / intake": [
    {
      test: "smoke test intake from throttle body to valve covers",
      cost: "medium",
      reads: "any open vacuum leak",
    },
    {
      test: "vacuum gauge at idle (steady 17-21 inHg = healthy)",
      cost: "cheap",
      reads: "general engine health + leaks",
    },
    {
      test: "spray carb cleaner around intake gaskets, listen for rpm change",
      cost: "cheap",
      reads: "specific gasket leak",
    },
    {
      test: "inspect PCV valve operation (rattle when shaken)",
      cost: "cheap",
      reads: "PCV stuck open/closed",
    },
  ],
  compression: [
    {
      test: "dry compression test on each cylinder (within 10% of each other)",
      cost: "medium",
      reads: "ring + valve sealing",
    },
    {
      test: "wet compression test (squirt of oil — improvement = ring wear)",
      cost: "medium",
      reads: "isolates rings vs valves",
    },
    {
      test: "leak-down test (where does air escape?)",
      cost: "expensive",
      reads: "exact leak path: rings, valves, head gasket",
    },
  ],
  evap: [
    {
      test: "verify fuel cap seated + intact",
      cost: "cheap",
      reads: "most common P0442/P0455 cause",
    },
    { test: "EVAP smoke test from service port", cost: "medium", reads: "leak location" },
    {
      test: "actuator-test purge + vent valves with scan tool",
      cost: "medium",
      reads: "valve operation",
    },
  ],
  "coolant level / leak": [
    {
      test: "cold visual inspection: reservoir level, hose clamps, water pump weep",
      cost: "cheap",
      reads: "obvious leaks + level",
    },
    {
      test: "pressure test cooling system at 15 psi for 15 min",
      cost: "medium",
      reads: "any leak under operating pressure",
    },
    {
      test: "UV dye + UV light after a drive cycle",
      cost: "medium",
      reads: "small/intermittent leak source",
    },
    {
      test: "block test (combustion gas in coolant)",
      cost: "medium",
      reads: "head gasket failure",
    },
  ],
  thermostat: [
    {
      test: "graph ECT scan-tool reading during warm-up",
      cost: "cheap",
      reads: "stuck-open: never reaches 195°F",
    },
    {
      test: "IR temp gun on upper hose (should jump when stat opens)",
      cost: "cheap",
      reads: "thermostat actually opening",
    },
    {
      test: "remove thermostat, test in hot water vs spec opening temp",
      cost: "cheap",
      reads: "bench-test mechanical",
    },
  ],
  "water pump": [
    {
      test: "look for weep hole leakage (cold + after warm-up)",
      cost: "cheap",
      reads: "internal seal failure",
    },
    { test: "rock pump pulley by hand for play/grind", cost: "cheap", reads: "bearing wear" },
    {
      test: "infrared temp upstream vs downstream of pump (running)",
      cost: "cheap",
      reads: "impeller flow",
    },
  ],
  "radiator fan": [
    {
      test: "scan tool actuator test on fan relays / PWM",
      cost: "medium",
      reads: "command path works",
    },
    {
      test: "let engine reach ~210°F, watch fan engage",
      cost: "cheap",
      reads: "fan engages at temp",
    },
    {
      test: "fan motor current draw / voltage at fan connector",
      cost: "medium",
      reads: "fan motor + wiring",
    },
  ],
  "head gasket": [
    {
      test: "block test on coolant (CO2 = head gasket)",
      cost: "medium",
      reads: "combustion gas in coolant",
    },
    {
      test: "compression + cooling pressure test (compression rises = gasket leak)",
      cost: "expensive",
      reads: "cylinder-to-coolant breach",
    },
    {
      test: "borescope cylinders for coolant wash",
      cost: "expensive",
      reads: "wet cylinder = leak path",
    },
  ],
  "brake pads": [
    {
      test: "measure pad thickness through wheel (>3mm safe)",
      cost: "cheap",
      reads: "remaining life",
    },
    {
      test: "rotor surface inspection (scoring, lip, bluing)",
      cost: "cheap",
      reads: "rotor condition",
    },
    {
      test: "pad/rotor temp difference left vs right after drive",
      cost: "cheap",
      reads: "uneven braking force",
    },
  ],
  rotors: [
    {
      test: "measure rotor thickness vs minimum spec stamped on rotor",
      cost: "cheap",
      reads: "machinable vs replace",
    },
    {
      test: 'dial indicator runout check (typical limit 0.002")',
      cost: "medium",
      reads: "warp / parallelism",
    },
    {
      test: "brake pulsation road test, identify front vs rear",
      cost: "cheap",
      reads: "which rotor is warped",
    },
  ],
  calipers: [
    {
      test: "inspect slide pins for free movement (lubricate + reinstall)",
      cost: "cheap",
      reads: "stuck pin = uneven wear",
    },
    {
      test: "compress piston, check for bind / corrosion",
      cost: "cheap",
      reads: "piston condition",
    },
    {
      test: "infrared temp on each rotor after a drive (stuck = much hotter)",
      cost: "cheap",
      reads: "stuck caliper detection",
    },
  ],
  "tire balance": [
    {
      test: "road force balance with shop machine",
      cost: "medium",
      reads: "out-of-round + balance issues",
    },
    {
      test: "rotate front/rear, see if shake follows tires",
      cost: "cheap",
      reads: "isolates tires from suspension",
    },
  ],
  "wheel bearing": [
    {
      test: "lift vehicle, rock wheel at 12/6 + 9/3 — listen + feel for play",
      cost: "cheap",
      reads: "bearing play",
    },
    {
      test: "spin wheel by hand, listen for grind / roughness",
      cost: "cheap",
      reads: "bearing roughness",
    },
    {
      test: "infrared temp on hub after drive (warm = bearing dragging)",
      cost: "cheap",
      reads: "bearing failure progression",
    },
  ],
  alignment: [
    {
      test: "tire wear pattern inspection (toe / camber wear)",
      cost: "cheap",
      reads: "alignment direction",
    },
    { test: "string box or laser alignment check", cost: "medium", reads: "approximate angles" },
    { test: "professional 4-wheel alignment", cost: "expensive", reads: "exact spec measurement" },
  ],
  "transmission fluid": [
    {
      test: "check fluid level + condition (pink/red healthy; brown/burnt = bad)",
      cost: "cheap",
      reads: "fluid health",
    },
    {
      test: "smell fluid (burnt smell = clutch wear)",
      cost: "cheap",
      reads: "internal wear indicator",
    },
    {
      test: "fluid + filter service (or full exchange) and recheck behavior",
      cost: "medium",
      reads: "rules in/out fluid as cause",
    },
  ],
  "torque converter": [
    {
      test: "TCC apply test on scan tool while road testing",
      cost: "medium",
      reads: "lockup engagement",
    },
    {
      test: "feel for shudder at light cruise 40-55mph (TCC slipping)",
      cost: "cheap",
      reads: "classic TCC shudder",
    },
  ],
  "solenoids / TCM": [
    {
      test: "scan TCM-side codes (P0700 in ECM = look at TCM for real code)",
      cost: "cheap",
      reads: "specific solenoid fault",
    },
    {
      test: "actuator-test individual solenoids on scan tool",
      cost: "medium",
      reads: "solenoid response",
    },
  ],
  refrigerant: [
    {
      test: "manifold gauge low/high side at idle vs spec",
      cost: "medium",
      reads: "charge level + system pressure",
    },
    {
      test: "vent temp at center dash (should be 35-45°F at idle, max fan, recirc)",
      cost: "cheap",
      reads: "system performance",
    },
    {
      test: "UV dye + light search at fittings + condenser + compressor",
      cost: "medium",
      reads: "leak location",
    },
  ],
  compressor: [
    {
      test: "command compressor clutch on with scan tool, watch for engagement",
      cost: "medium",
      reads: "clutch + circuit",
    },
    {
      test: "voltage at clutch coil during command",
      cost: "cheap",
      reads: "electrical command vs mechanical clutch",
    },
    {
      test: "pressure cycling switch resistance / test",
      cost: "cheap",
      reads: "low-pressure cutoff misbehaving",
    },
  ],
  "valve seals": [
    {
      test: "blue smoke at startup after sitting overnight",
      cost: "cheap",
      reads: "valve seal classic symptom",
    },
    {
      test: "compression vs leak-down — leak-down through intake or exhaust valves",
      cost: "expensive",
      reads: "valve sealing vs ring sealing",
    },
  ],
  "piston rings": [
    {
      test: "wet vs dry compression test (improvement on wet = ring wear)",
      cost: "medium",
      reads: "rings vs valves",
    },
    {
      test: "leak-down — air escapes out crankcase / oil filler",
      cost: "expensive",
      reads: "ring sealing",
    },
    {
      test: "blow-by check at oil filler with engine running",
      cost: "cheap",
      reads: "ring/cylinder wear",
    },
  ],
};

const planSchema = z.object({
  system: z
    .string()
    .describe(
      "Candidate system to plan tests for (e.g. 'fuel', 'ignition', 'cooling'). " +
        "Match keys returned by isolate_systems for best results.",
    ),
});

export const planPinpointTestsTool = {
  name: "plan_pinpoint_tests",
  description: "Given a candidate vehicle system, return an ordered list of pinpoint tests " +
    "(cheapest → most invasive) with what each test reveals. Use AFTER isolate_systems " +
    "to give the customer concrete next steps. Tests are framed so a tech (or a " +
    "customer with basic tools and time) can run them.",
  schema: planSchema,
  // deno-lint-ignore require-await
  execute: async (params: z.infer<typeof planSchema>) => {
    const tests = TESTS_BY_SYSTEM[params.system.toLowerCase()];
    if (tests) {
      return toolResult({ system: params.system, tests, found: true });
    }
    return toolResult({
      system: params.system,
      tests: [],
      found: false,
      note: "No canned test plan for this system — ask the customer for specifics " +
        "(what changed, what's been ruled out) and propose tests from first principles.",
    });
  },
};
