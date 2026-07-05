import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  // Dev-only: proxy the Tesla decryption-key endpoint through the dev server so
  // the browser makes a same-origin request (no CORS). In production the app is
  // static (`output: "export"`), so this rewrite is omitted from the build and
  // nginx performs the same proxy (see nginx.conf `/tesla-decrypt/`).
  ...(process.env.NODE_ENV === "development"
    ? {
        async rewrites() {
          return [
            {
              source: "/tesla-decrypt/:path*",
              destination: "https://dashcam.tesla.com/:path*",
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
