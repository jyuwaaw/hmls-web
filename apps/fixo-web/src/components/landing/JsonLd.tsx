import { LANDING_FAQS } from "./faqs";

const SITE_URL = "https://fixo.hmls.autos";

/**
 * Public social profiles for the Knowledge Graph `sameAs` claim. Add a URL
 * here the moment a handle exists — Google ties these to the Organization
 * entity for richer SERP results. Empty array is fine until then; broken
 * URLs would actively hurt the signal.
 */
const SOCIAL_PROFILES: string[] = [
  // "https://x.com/fixo",
  // "https://www.linkedin.com/company/fixo",
  // "https://www.youtube.com/@fixo",
  // "https://www.instagram.com/fixo",
  // "https://github.com/fixo",
];

const organization = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Fixo",
  url: SITE_URL,
  logo: `${SITE_URL}/icon-512.png`,
  description:
    "AI-powered vehicle diagnostics. Snap a photo, record the noise, or paste an OBD-II code — get a real diagnosis with parts and labor estimate in 30 seconds.",
  sameAs: SOCIAL_PROFILES,
};

const website = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Fixo",
  url: SITE_URL,
  potentialAction: {
    "@type": "SearchAction",
    target: `${SITE_URL}/chat?q={search_term_string}`,
    "query-input": "required name=search_term_string",
  },
};

const softwareApplication = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Fixo",
  applicationCategory: "AutomotiveApplication",
  operatingSystem: "Web, iOS, Android",
  url: SITE_URL,
  description:
    "AI car diagnosis from photos, audio, OBD-II codes, or symptom descriptions. Returns a real diagnosis with severity rating and cost estimate in 30 seconds.",
  offers: [
    {
      "@type": "Offer",
      name: "Free",
      price: "0",
      priceCurrency: "USD",
      description: "200 credits per month — about one full diagnosis.",
    },
    {
      "@type": "Offer",
      name: "Plus",
      price: "19.90",
      priceCurrency: "USD",
      description:
        "2,000 credits per month — about 13 full diagnoses. Auto-renews monthly.",
    },
  ],
};

const faqPage = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: LANDING_FAQS.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: f.a,
    },
  })),
};

/**
 * Escape `<` so any payload containing the literal `</script>` cannot break
 * out of the surrounding script tag. JSON parsers treat `<` and `<` as
 * the same character, so structured-data crawlers still parse this correctly.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function JsonLd() {
  const blocks = [organization, website, softwareApplication, faqPage];
  return (
    <>
      {blocks.map((data) => (
        <script key={data["@type"]} type="application/ld+json">
          {safeJson(data)}
        </script>
      ))}
    </>
  );
}
