import type { MetadataRoute } from "next";

const SITE_URL = "https://fixo.hmls.autos";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Authenticated areas — no index value in there for crawlers, and
        // they require login anyway. Block to keep the indexed surface tight.
        disallow: ["/chat", "/settings", "/auth/", "/api/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
