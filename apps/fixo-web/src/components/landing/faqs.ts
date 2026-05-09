/**
 * Landing-page FAQ source of truth. Imported by both the client-rendered
 * FaqSection and the server-rendered FAQPage JSON-LD — keep questions and
 * answers in this one file so the two stay in sync.
 *
 * Plain `.ts` (not `.tsx`, no `"use client"`) so server components can read
 * it as data, not as a serialized client-module proxy.
 */
export const LANDING_FAQS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "How accurate is an AI diagnosis vs. a real mechanic?",
    a: "Fixo cross-references your inputs against a database of OBD-II codes, common failure patterns, and shop-rate labor times. It's accurate enough to walk into a shop knowing what to ask for, and it'll tell you when a problem genuinely needs a hands-on inspection. Treat it as a strong second opinion, not a substitute for a wrench.",
  },
  {
    q: "Do I need an OBD-II scanner?",
    a: "No. Most diagnoses start from a photo, a description, or a sound. If you do have an OBD-II reader, you can paste in DTC codes (P0420, P0171, etc.) for sharper results — but it's optional.",
  },
  {
    q: "What kinds of car problems can Fixo diagnose?",
    a: "Engine codes, fluid leaks, strange noises (clicks, knocks, whines), vibration, dashboard warning lights, brake or suspension issues, electrical glitches, and more. If you can describe it, photograph it, or record it, Fixo can usually narrow it down.",
  },
  {
    q: "Is my data private?",
    a: "Yes. Photos and audio you upload are used only to generate your diagnosis and stored in your private history. We don't sell your data and we don't train public models on it.",
  },
  {
    q: "Does Fixo work on any make and model?",
    a: "It works on most gas, hybrid, and electric vehicles from major manufacturers. OBD-II coverage is universal for any 1996+ US-market car. Newer EVs and rare imports may have less specific guidance, but symptom-based diagnosis still applies.",
  },
  {
    q: "How much does it cost?",
    a: "Free tier covers ~1 full diagnosis a month with no credit card. Plus is $19.90/month for ~13 diagnoses — less than the inspection fee at most shops, every month. Top-up packs available at $1 = 100 credits for heavy weeks.",
  },
] as const;
