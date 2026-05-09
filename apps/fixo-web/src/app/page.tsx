import { AudienceSection } from "@/components/landing/AudienceSection";
import { CTASection } from "@/components/landing/CTASection";
import { DiagnosisSection } from "@/components/landing/DiagnosisSection";
import { FaqSection } from "@/components/landing/FaqSection";
import { Footer } from "@/components/landing/Footer";
import { HeroSection } from "@/components/landing/HeroSection";
import { InputMethodsSection } from "@/components/landing/InputMethodsSection";
import { JsonLd } from "@/components/landing/JsonLd";
import { NavBar } from "@/components/landing/NavBar";
import { PricingSection } from "@/components/landing/PricingSection";
import { TrustSection } from "@/components/landing/TrustSection";

export default function LandingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <JsonLd />
      <NavBar />
      <main>
        <HeroSection />
        <InputMethodsSection />
        <DiagnosisSection />
        <AudienceSection />
        <TrustSection />
        <PricingSection />
        <FaqSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}
