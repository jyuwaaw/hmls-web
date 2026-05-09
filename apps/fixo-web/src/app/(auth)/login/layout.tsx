import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign In",
  description:
    "Sign in to Fixo to run AI car diagnoses, save vehicles, and download PDF diagnostic reports.",
  alternates: { canonical: "/login" },
  // Auth pages don't add SERP value; let crawlers see the URL via sitemap
  // for discovery but don't index the form itself.
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: "Sign In | Fixo",
    description: "Sign in to Fixo — AI car diagnostics in 30 seconds.",
    url: "/login",
    type: "website",
  },
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
