import { ImageResponse } from "next/og";

export const alt = "HMLS Mobile Mechanic - San Jose & Orange County";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OGImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #dc2626 0%, #1a1a1a 100%)",
      }}
    >
      <span
        style={{
          fontSize: 80,
          fontWeight: 800,
          color: "#ffffff",
          letterSpacing: "-0.02em",
        }}
      >
        HMLS
      </span>
      <span
        style={{
          fontSize: 32,
          fontWeight: 400,
          color: "rgba(255,255,255,0.85)",
          marginTop: 12,
        }}
      >
        Mobile Mechanic — San Jose &amp; Orange County
      </span>
    </div>,
    { ...size },
  );
}
