import type { MetadataRoute } from "next";
import { OBD_SEO_CODES_LIST } from "@/data/obd-seed";
import { SITE_URL } from "@/lib/seo-config";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/pricing`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/login`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/obd`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.85,
    },
  ];

  // SEO landing pages — one entry per OBD-II code in OBD_SEO_CODES_LIST.
  // High priority because these are the search-volume targets for the
  // fixo Speed Wedge推广 plan.
  const obdPages: MetadataRoute.Sitemap = OBD_SEO_CODES_LIST.map((entry) => ({
    url: `${SITE_URL}/obd/${entry.code}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  return [...staticPages, ...obdPages];
}
