import { z } from "zod";
import { toolResult } from "@hmls/shared/tool-result";

const lookupObdCodeSchema = z.object({
  code: z.string().describe("OBD-II code to look up (e.g., P0301)"),
});

interface ObdCodeEntry {
  description: string;
  system: string;
  /** Likely physical root causes ordered by prevalence in shop data. */
  commonRootCauses: string[];
  /** Pinpoint tests a tech (or a customer with a code reader + a few minutes)
   *  can run, ordered cheapest → most invasive. */
  pinpointTests: string[];
}

// Reference data: top ~30 most-seen DTCs with shop-grade root causes and
// pinpoint tests. Source-of-truth for the Fixo agent's "scan + isolate"
// stage. Keep alphabetical-ish by code and prefer concrete causes ("dirty
// MAF sensor") over symptom restatements ("lean condition").
const OBD_CODES: Record<string, ObdCodeEntry> = {
  // ----- Misfire codes (P030x) -------------------------------------------
  P0300: {
    description: "Random/Multiple Cylinder Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "worn spark plugs",
      "failing ignition coil(s)",
      "vacuum leak",
      "weak fuel pump or clogged fuel filter",
      "dirty/failing fuel injectors",
      "low compression on one or more cylinders",
    ],
    pinpointTests: [
      "scan misfire counters per cylinder (live data)",
      "swap suspect coil and plug to a different cylinder, recheck misfire counter",
      "fuel pressure test (key-on, running, snap-throttle)",
      "compression test on offending cylinders",
      "smoke test intake for vacuum leak",
    ],
  },
  P0301: {
    description: "Cylinder 1 Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "spark plug worn or fouled (cyl 1)",
      "ignition coil failing (cyl 1)",
      "fuel injector clogged or stuck (cyl 1)",
      "low compression cyl 1",
      "intake manifold leak near cyl 1",
    ],
    pinpointTests: [
      "swap coil + plug from cyl 1 to a known-good cylinder, see if misfire follows",
      "scope ignition primary/secondary on cyl 1",
      "compression + leak-down test on cyl 1",
      "injector balance test",
    ],
  },
  P0302: {
    description: "Cylinder 2 Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "spark plug worn or fouled (cyl 2)",
      "ignition coil failing (cyl 2)",
      "fuel injector issue (cyl 2)",
      "low compression cyl 2",
    ],
    pinpointTests: [
      "swap coil + plug from cyl 2 to a known-good cylinder",
      "compression + leak-down test on cyl 2",
      "injector balance test",
    ],
  },
  P0303: {
    description: "Cylinder 3 Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "spark plug worn or fouled (cyl 3)",
      "ignition coil failing (cyl 3)",
      "fuel injector issue (cyl 3)",
      "low compression cyl 3",
    ],
    pinpointTests: [
      "swap coil + plug from cyl 3 to a known-good cylinder",
      "compression + leak-down test on cyl 3",
    ],
  },
  P0304: {
    description: "Cylinder 4 Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "spark plug worn or fouled (cyl 4)",
      "ignition coil failing (cyl 4)",
      "fuel injector issue (cyl 4)",
      "low compression cyl 4",
    ],
    pinpointTests: [
      "swap coil + plug from cyl 4 to a known-good cylinder",
      "compression + leak-down test on cyl 4",
    ],
  },
  P0305: {
    description: "Cylinder 5 Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "spark plug worn or fouled (cyl 5)",
      "ignition coil failing (cyl 5)",
      "fuel injector issue (cyl 5)",
      "low compression cyl 5",
    ],
    pinpointTests: [
      "swap coil + plug from cyl 5 to a known-good cylinder",
      "compression + leak-down test on cyl 5",
    ],
  },
  P0306: {
    description: "Cylinder 6 Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "spark plug worn or fouled (cyl 6)",
      "ignition coil failing (cyl 6)",
      "fuel injector issue (cyl 6)",
      "low compression cyl 6",
    ],
    pinpointTests: [
      "swap coil + plug from cyl 6 to a known-good cylinder",
      "compression + leak-down test on cyl 6",
    ],
  },
  P0307: {
    description: "Cylinder 7 Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "spark plug worn or fouled (cyl 7)",
      "ignition coil failing (cyl 7)",
      "fuel injector issue (cyl 7)",
      "low compression cyl 7",
    ],
    pinpointTests: [
      "swap coil + plug from cyl 7 to a known-good cylinder",
      "compression + leak-down test on cyl 7",
    ],
  },
  P0308: {
    description: "Cylinder 8 Misfire Detected",
    system: "Ignition",
    commonRootCauses: [
      "spark plug worn or fouled (cyl 8)",
      "ignition coil failing (cyl 8)",
      "fuel injector issue (cyl 8)",
      "low compression cyl 8",
    ],
    pinpointTests: [
      "swap coil + plug from cyl 8 to a known-good cylinder",
      "compression + leak-down test on cyl 8",
    ],
  },

  // ----- Fuel trim (P017x) -----------------------------------------------
  P0171: {
    description: "System Too Lean (Bank 1)",
    system: "Fuel",
    commonRootCauses: [
      "vacuum leak (intake boot, manifold gasket, brake booster)",
      "dirty or failing MAF sensor",
      "weak fuel pump / clogged fuel filter",
      "leaking or clogged fuel injectors",
      "exhaust leak upstream of front O2 sensor",
      "stuck-open PCV valve",
    ],
    pinpointTests: [
      "smoke test intake + brake booster + PCV for vacuum leaks",
      "fuel pressure test (key-on, running, snap-throttle)",
      "MAF g/s reading at idle vs spec; clean and recheck",
      "inspect for cracked intake boot / loose clamps",
      "scope front O2 sensor — check for skewed bias",
    ],
  },
  P0172: {
    description: "System Too Rich (Bank 1)",
    system: "Fuel",
    commonRootCauses: [
      "leaking fuel injector",
      "failing fuel pressure regulator",
      "dirty MAF reading high",
      "stuck-closed EVAP purge valve flooding intake on shutdown",
      "front O2 sensor lazy/biased rich",
    ],
    pinpointTests: [
      "fuel pressure test at idle and key-off hold (bleed-down)",
      "scope front O2 sensor + check fuel trims at idle and 2500 rpm",
      "injector balance / leak-down (back-leak into rail)",
      "MAF cleaning + recheck",
    ],
  },
  P0174: {
    description: "System Too Lean (Bank 2)",
    system: "Fuel",
    commonRootCauses: [
      "vacuum leak on bank 2 intake runner",
      "dirty or failing MAF sensor (V engines share one MAF)",
      "weak fuel pump (affects both banks but shows on bank 2 first if lined unevenly)",
      "exhaust leak upstream of bank 2 O2 sensor",
    ],
    pinpointTests: [
      "smoke test intake — focus on bank 2 runners and gaskets",
      "fuel pressure test",
      "compare bank 1 vs bank 2 long-term fuel trim",
      "inspect bank 2 exhaust manifold / gasket for leaks",
    ],
  },
  P0175: {
    description: "System Too Rich (Bank 2)",
    system: "Fuel",
    commonRootCauses: [
      "leaking fuel injector on bank 2",
      "failing fuel pressure regulator",
      "lazy bank 2 front O2 sensor",
    ],
    pinpointTests: [
      "fuel pressure test + bleed-down",
      "scope bank 2 front O2 sensor",
      "injector balance test on bank 2",
    ],
  },

  // ----- Emissions / catalyst (P042x, P044x, P045x) ----------------------
  P0420: {
    description: "Catalyst System Efficiency Below Threshold (Bank 1)",
    system: "Emissions",
    commonRootCauses: [
      "failed catalytic converter (bank 1)",
      "lazy or contaminated rear O2 sensor",
      "exhaust leak before/after the catalyst",
      "engine running rich for extended period (oil burning, coolant ingestion) damaging the cat",
    ],
    pinpointTests: [
      "scope front + rear O2 sensors during steady cruise — rear should be flat",
      "infrared temp pre- vs post-cat (post should be 50–100°F hotter on a healthy cat)",
      "exhaust back-pressure test",
      "verify no current misfire or fuel-trim DTC corrupting the reading",
    ],
  },
  P0430: {
    description: "Catalyst System Efficiency Below Threshold (Bank 2)",
    system: "Emissions",
    commonRootCauses: [
      "failed catalytic converter (bank 2)",
      "lazy or contaminated bank 2 rear O2 sensor",
      "exhaust leak on bank 2",
    ],
    pinpointTests: [
      "scope bank 2 front + rear O2 sensors at steady cruise",
      "infrared temp pre- vs post-cat on bank 2",
      "exhaust leak inspection bank 2",
    ],
  },
  P0440: {
    description: "Evaporative Emission Control System Malfunction",
    system: "EVAP",
    commonRootCauses: [
      "loose or failing fuel cap",
      "cracked EVAP hose",
      "failing purge or vent valve",
      "leaking charcoal canister",
    ],
    pinpointTests: [
      "tighten + reseat fuel cap, clear code, drive cycle",
      "EVAP smoke test from service port",
      "scan-tool actuator test on purge and vent valves",
    ],
  },
  P0442: {
    description: "Evaporative Emission Control System Leak Detected (small leak)",
    system: "EVAP",
    commonRootCauses: [
      "loose or worn fuel cap (most common)",
      "cracked EVAP hose or connector",
      "failing purge valve seat",
    ],
    pinpointTests: [
      "inspect + retorque fuel cap; clear code and re-test",
      "EVAP smoke test",
      "actuator-test purge/vent valves with scan tool",
    ],
  },
  P0455: {
    description: "Evaporative Emission Control System Leak Detected (gross leak)",
    system: "EVAP",
    commonRootCauses: [
      "missing or completely loose fuel cap",
      "disconnected EVAP hose",
      "stuck-open vent valve",
      "punctured charcoal canister",
    ],
    pinpointTests: [
      "verify fuel cap is in place and seated",
      "EVAP smoke test (will find gross leaks instantly)",
      "actuator-test vent valve, listen for click",
    ],
  },
  P0456: {
    description: "Evaporative Emission Control System Leak Detected (very small leak)",
    system: "EVAP",
    commonRootCauses: [
      "fuel cap o-ring degraded",
      "pinhole in EVAP hose",
      "purge valve weeping",
    ],
    pinpointTests: [
      "EVAP smoke test with low-pressure smoke + UV dye",
      "replace fuel cap as a low-cost first step",
    ],
  },

  // ----- Engine timing (P001x, P0128) ------------------------------------
  P0011: {
    description: "Intake Camshaft Position Timing Over-Advanced (Bank 1)",
    system: "Timing",
    commonRootCauses: [
      "low or dirty engine oil starving the VVT actuator",
      "failing VVT (variable valve timing) solenoid bank 1",
      "stuck VVT actuator / cam phaser",
      "timing chain stretch",
    ],
    pinpointTests: [
      "verify oil level + condition; perform fresh oil change with correct viscosity",
      "actuator-test VVT solenoid with scan tool",
      "swap bank 1 / bank 2 VVT solenoid (V engines), see if code follows",
      "scope camshaft position vs crankshaft position at idle and 2500 rpm",
    ],
  },
  P0012: {
    description: "Intake Camshaft Position Timing Over-Retarded (Bank 1)",
    system: "Timing",
    commonRootCauses: [
      "VVT solenoid stuck / failing bank 1",
      "low oil pressure",
      "timing chain stretch / jumped tooth",
      "cam phaser internal failure",
    ],
    pinpointTests: [
      "oil pressure test at idle and 2500 rpm",
      "actuator-test VVT solenoid",
      "scope cam vs crank correlation",
      "physical inspection of timing components (cover off if needed)",
    ],
  },
  P0128: {
    description: "Coolant Thermostat Below Regulating Temperature",
    system: "Cooling",
    commonRootCauses: [
      "stuck-open thermostat (most common)",
      "failed coolant temp sensor reading low",
      "wiring issue at ECT sensor",
    ],
    pinpointTests: [
      "compare scan-tool ECT vs IR-gun reading at thermostat housing after warm-up",
      "watch ECT graph during warm-up — healthy thermostat opens around 195°F and holds",
      "replace thermostat (lowest-cost first step on a confirmed P0128)",
    ],
  },

  // ----- Transmission ----------------------------------------------------
  P0700: {
    description: "Transmission Control System Malfunction",
    system: "Transmission",
    commonRootCauses: [
      "secondary trans code present (look for P07xx companion code)",
      "low or burnt transmission fluid",
      "TCM internal fault",
      "failing trans speed sensors",
    ],
    pinpointTests: [
      "scan ALL modules — P0700 is the engine-module's record that the trans module set its own code; the real fault is whatever P07xx is in the TCM",
      "inspect trans fluid level + condition",
      "check TCM-to-ECM communication on data bus",
    ],
  },
  P0715: {
    description: "Input/Turbine Speed Sensor Circuit Malfunction",
    system: "Transmission",
    commonRootCauses: [
      "failing input speed sensor",
      "harness corrosion / chafe at the trans connector",
      "metal debris on sensor tip (internal trans wear)",
    ],
    pinpointTests: [
      "scope input speed sensor signal during a road test",
      "inspect connector + harness for damage",
      "pull sensor and inspect tip for ferrous debris",
    ],
  },

  // ----- Sensors (P010x, P011x, P013x, P0500) ----------------------------
  P0101: {
    description: "Mass Air Flow Circuit Range/Performance Problem",
    system: "Sensors",
    commonRootCauses: [
      "dirty MAF sensor element",
      "intake leak between MAF and throttle body",
      "torn intake boot",
      "failing MAF sensor",
      "restricted air filter",
    ],
    pinpointTests: [
      "compare MAF g/s at idle and WOT vs spec for the engine",
      "clean MAF with electronics-safe MAF cleaner; recheck",
      "smoke test post-MAF intake",
      "inspect air filter",
    ],
  },
  P0102: {
    description: "Mass Air Flow Circuit Low Input",
    system: "Sensors",
    commonRootCauses: [
      "MAF sensor unplugged or damaged",
      "MAF signal wire open / shorted to ground",
      "failed MAF sensor (no output)",
    ],
    pinpointTests: [
      "verify MAF connector seated + intact",
      "back-probe signal wire — should read ~0.5–1.0 V at key-on, rising with rpm",
      "swap with known-good MAF",
    ],
  },
  P0103: {
    description: "Mass Air Flow Circuit High Input",
    system: "Sensors",
    commonRootCauses: [
      "MAF signal wire shorted to power",
      "failed MAF sensor reading high",
      "incorrect MAF for engine",
    ],
    pinpointTests: [
      "back-probe MAF signal wire at key-on engine-off — should not read battery voltage",
      "swap with known-good MAF",
    ],
  },
  P0113: {
    description: "Intake Air Temperature Circuit High Input",
    system: "Sensors",
    commonRootCauses: [
      "IAT sensor wire open",
      "failed IAT sensor reading max",
      "IAT integrated into MAF — failing MAF (combo sensor)",
    ],
    pinpointTests: [
      "scan-tool IAT reading at key-on cold should match ambient",
      "back-probe IAT signal/ground continuity",
      "if integrated, replace MAF/IAT combo",
    ],
  },
  P0117: {
    description: "Engine Coolant Temperature Circuit Low Input",
    system: "Sensors",
    commonRootCauses: [
      "ECT signal wire shorted to ground",
      "failed ECT sensor reading min (often paired with overheating concerns even if engine is fine)",
    ],
    pinpointTests: [
      "scan-tool ECT — back-probe sensor at key-on, should be ~0.5–4.5 V varying with temp",
      "compare ECT reading to IR-gun temp at sensor housing",
    ],
  },
  P0118: {
    description: "Engine Coolant Temperature Circuit High Input",
    system: "Sensors",
    commonRootCauses: [
      "ECT signal wire open",
      "failed ECT sensor (high resistance)",
      "corroded ECT connector",
    ],
    pinpointTests: [
      "back-probe ECT — should read sensible voltage at key-on cold",
      "ohm out the sensor cold and warm vs spec",
    ],
  },
  P0131: {
    description: "O2 Sensor Circuit Low Voltage (Bank 1 Sensor 1)",
    system: "Sensors",
    commonRootCauses: [
      "O2 sensor shorted internally (low output)",
      "exhaust leak upstream of the sensor causing constant lean",
      "extreme lean fuel mixture (vacuum leak, weak fuel pump)",
      "O2 wiring shorted to ground",
    ],
    pinpointTests: [
      "scope front O2 sensor — healthy O2 oscillates 0.1–0.9 V at warm idle",
      "check for upstream exhaust leaks (smoke test or visual)",
      "fuel trims + fuel pressure to rule out actual lean condition",
    ],
  },
  P0134: {
    description: "O2 Sensor Circuit No Activity Detected (Bank 1 Sensor 1)",
    system: "Sensors",
    commonRootCauses: [
      "front O2 sensor heater failed (sensor never reaches operating temp)",
      "O2 signal wire open",
      "old / lazy O2 sensor",
    ],
    pinpointTests: [
      "scan-tool O2 heater current draw test",
      "back-probe O2 signal at key-on warm — should oscillate; if flat ~0.45 V, sensor is dead",
      "scope sensor signal during snap-throttle",
    ],
  },
  P0500: {
    description: "Vehicle Speed Sensor Malfunction",
    system: "Sensors",
    commonRootCauses: [
      "failing vehicle speed sensor (output speed sensor on most modern trans)",
      "wiring damage at the trans connector",
      "ABS module not broadcasting wheel-speed data on the bus (CAN issue)",
    ],
    pinpointTests: [
      "scan-tool VSS reading on a road test",
      "inspect VSS connector + wiring",
      "check for ABS / wheel-speed-sensor codes on other modules",
    ],
  },
};

export const lookupObdCodeTool = {
  name: "lookupObdCode",
  description: "Look up an OBD-II diagnostic trouble code. Returns description, system, " +
    "common physical root causes, and ordered pinpoint tests a tech (or a " +
    "customer with basic tools) can run to confirm the actual fault. Use " +
    "this BEFORE recommending a repair — a code is a direction, not an answer.",
  schema: lookupObdCodeSchema,
  // deno-lint-ignore require-await
  execute: async (params: z.infer<typeof lookupObdCodeSchema>) => {
    const { code } = params;
    const upperCode = code.toUpperCase().trim();

    const info = OBD_CODES[upperCode];

    if (info) {
      return toolResult({
        code: upperCode,
        description: info.description,
        system: info.system,
        commonRootCauses: info.commonRootCauses,
        pinpointTests: info.pinpointTests,
        found: true,
      });
    }

    // Parse code structure for unknown codes
    const codeType = upperCode[0];
    const typeMap: Record<string, string> = {
      P: "Powertrain",
      B: "Body",
      C: "Chassis",
      U: "Network",
    };

    return toolResult({
      code: upperCode,
      description: "Code not in reference database",
      system: typeMap[codeType] || "Unknown",
      commonRootCauses: [],
      pinpointTests: [],
      found: false,
      note: "Manufacturer-specific code or not in common database. Ask the user " +
        "for the vehicle make/model and search a make-specific reference, " +
        "or interpret based on conversation context.",
    });
  },
};
