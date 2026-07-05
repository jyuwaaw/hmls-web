// One-shot: parse a US Census ZCTA gazetteer .txt into a compact ZIP→[lat,lng] map.
// Download first (public domain, no key):
//   curl -sL "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip" -o /tmp/zcta.zip
//   unzip -o /tmp/zcta.zip -d /tmp
// Then: deno run --allow-read --allow-write apps/agent/scripts/gen-zip-centroids.ts /tmp/2023_Gaz_zcta_national.txt
// Tab-delimited columns: GEOID  ALAND  AWATER  ALAND_SQMI  AWATER_SQMI  INTPTLAT  INTPTLONG
const src = Deno.args[0];
if (!src) throw new Error("usage: gen-zip-centroids.ts <gazetteer.txt>");
const text = await Deno.readTextFile(src);
const lines = text.split("\n");
const out: Record<string, [number, number]> = {};
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split("\t").map((c) => c.trim());
  if (cols.length < 7) continue;
  const zip = cols[0];
  const lat = Number(cols[cols.length - 2]);
  const lng = Number(cols[cols.length - 1]);
  if (!/^\d{5}$/.test(zip) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  out[zip] = [Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4];
}
const dest = new URL("../src/common/data/zip-centroids.json", import.meta.url).pathname;
await Deno.mkdir(new URL("../src/common/data/", import.meta.url).pathname, { recursive: true });
await Deno.writeTextFile(dest, JSON.stringify(out));
console.log(`wrote ${Object.keys(out).length} ZIP centroids to ${dest}`);
