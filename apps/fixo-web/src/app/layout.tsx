import type { Metadata, Viewport } from "next";
import { Geist, Inter } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/components/AuthProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const dynamic = "force-dynamic";

const SITE_URL = "https://fixo.hmls.autos";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Fixo — AI Car Diagnosis in 30 Seconds | Photo, Sound, OBD-II",
    template: "%s | Fixo",
  },
  description:
    "Skip the $150 shop diagnostic fee. Snap a photo, record the noise, or paste an OBD-II code — Fixo's AI returns a real diagnosis with parts and labor estimate in 30 seconds. Free to start.",
  applicationName: "Fixo",
  authors: [{ name: "Fixo" }],
  keywords: [
    "AI car diagnosis",
    "OBD-II scanner app",
    "what's wrong with my car",
    "car repair cost estimate",
    "engine code lookup",
    "check engine light",
    "vehicle diagnostic AI",
    "car symptom checker",
    "DTC code reader",
    "auto repair estimate",
  ],
  category: "Automotive",
  manifest: "/manifest.json",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    siteName: "Fixo",
    title: "Fixo — AI Car Diagnosis in 30 Seconds",
    description:
      "Skip the $150 shop fee. Photo, sound, or OBD-II code in — real diagnosis with cost estimate out. Free to start.",
    url: SITE_URL,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Fixo — AI Car Diagnosis in 30 Seconds",
    description:
      "Skip the $150 shop fee. Photo, sound, or OBD-II code in — real diagnosis with cost estimate out.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Fixo",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("font-sans", geist.variable)}
    >
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#000000" />
      </head>
      <body
        className={`${inter.variable} font-sans antialiased bg-background text-text min-h-dvh`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>
            <AuthProvider>{children}</AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
