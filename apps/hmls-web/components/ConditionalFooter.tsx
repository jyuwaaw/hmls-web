"use client";

import { usePathname } from "next/navigation";
import Footer from "./Footer";

/** Routes where the marketing footer is hidden — full-bleed surfaces that
 *  fill viewport height and would otherwise force the body to grow past
 *  100dvh and produce a redundant page-level scrollbar alongside the
 *  in-page chat scroll. */
const FOOTERLESS_ROUTES = ["/chat"];

export default function ConditionalFooter() {
  const pathname = usePathname();
  if (
    FOOTERLESS_ROUTES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
  ) {
    return null;
  }
  return <Footer />;
}
