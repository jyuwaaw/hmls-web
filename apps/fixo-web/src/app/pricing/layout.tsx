import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — $19.90/mo or Free Tier (200 Credits/Month)",
  description:
    "Skip the $150 shop diagnostic fee. Free tier covers one full AI car diagnosis a month. Plus is $19.90/mo for ~13 diagnoses — photos, audio, OBD-II, PDF reports. Cancel any time.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Fixo Pricing — $19.90/mo or Free",
    description:
      "Free tier: one full diagnosis a month, no card. Plus: ~13 a month for $19.90. Cheaper than one shop visit, every month.",
    url: "/pricing",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Fixo Pricing — $19.90/mo or Free",
    description:
      "Free tier: 1 full diagnosis a month. Plus: ~13 a month for $19.90. Cheaper than one shop visit.",
  },
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
