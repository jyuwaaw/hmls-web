import type { MetadataRoute } from "next";
import { BUSINESS } from "@/lib/business";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BUSINESS.name,
    short_name: "HMLS",
    description: BUSINESS.shortDescription,
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#dc2626",
  };
}
