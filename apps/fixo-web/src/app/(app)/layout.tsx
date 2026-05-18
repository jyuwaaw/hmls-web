import { MobileDrawer, MobileDrawerProvider } from "@/components/MobileDrawer";
import { Sidebar } from "@/components/Sidebar";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <MobileDrawerProvider>
      <Sidebar />
      {/* Push main content right of the 240px sidebar at lg+. The pages
          handle their own scrolling (h-dvh + overflow-y-auto), so we only
          need horizontal padding here. */}
      <div className="lg:pl-60">{children}</div>
      <MobileDrawer />
    </MobileDrawerProvider>
  );
}
