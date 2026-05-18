import { SidebarContent } from "@/components/SidebarContent";

/**
 * Desktop sidebar (≥ lg). Mobile uses <MobileDrawer> instead — see AppLayout.
 * Fixed left column, 240px wide, full height. Body content lives in
 * <SidebarContent> so the drawer can reuse it.
 */
export function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 z-30 hidden h-dvh w-60 flex-col border-r border-border bg-background lg:flex">
      <SidebarContent />
    </aside>
  );
}
