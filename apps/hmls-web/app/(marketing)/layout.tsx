import ConditionalFooter from "@/components/ConditionalFooter";
import Navbar from "@/components/Navbar";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar />
      <div className="flex-1 flex flex-col">{children}</div>
      <ConditionalFooter />
    </>
  );
}
