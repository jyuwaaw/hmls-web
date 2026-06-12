import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { Barlow } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { JsonLd } from "@/components/JsonLd";
import { PageEnter } from "@/components/PageEnter";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ReasonDialog } from "@/components/ui/ReasonDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BUSINESS } from "@/lib/business";
import { websiteSchema } from "@/lib/schema";

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-barlow",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://hmls.autos"),
  title: {
    default: "HMLS Mobile Mechanic - San Jose & Orange County",
    template: "%s | HMLS Mobile Mechanic",
  },
  description: BUSINESS.description,
  keywords: [
    "mobile mechanic",
    "San Jose",
    "South Bay",
    "Orange County",
    "auto repair",
    "car mechanic near me",
    "mobile car repair",
    "mobile mechanic San Jose",
    "mobile mechanic Orange County",
  ],
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "HMLS Mobile Mechanic",
  },
  twitter: {
    card: "summary_large_image",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="scroll-smooth">
      <head>
        <meta
          name="theme-color"
          content="#fafafa"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#1c1917"
          media="(prefers-color-scheme: dark)"
        />
        <meta name="color-scheme" content="light dark" />
      </head>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} ${barlow.variable} font-sans antialiased bg-background text-foreground min-h-dvh flex flex-col`}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-lg focus:text-sm focus:font-medium"
        >
          Skip to content
        </a>
        <JsonLd data={websiteSchema()} />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <AuthProvider>
            <TooltipProvider>
              <PageEnter>{children}</PageEnter>
              <Toaster richColors position="bottom-right" />
              <ReasonDialog />
              <ConfirmDialog />
            </TooltipProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
