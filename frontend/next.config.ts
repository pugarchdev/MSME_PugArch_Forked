import type { NextConfig } from "next";
import path from "path";

const isAbsoluteHttpUrl = (value?: string): value is string => {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // localhost / 127.0.0.1 is NEVER a valid remote backend URL for proxy rewrites
  if (trimmed.includes("localhost") || trimmed.includes("127.0.0.1")) {
    return false;
  }
  return true;
};

const getBackendUrl = (): string => {
  // 1. Allow explicit override via BACKEND_URL or NEXT_PUBLIC_BACKEND_URL
  if (process.env.BACKEND_URL) {
    return process.env.BACKEND_URL.replace(/\/$/, "");
  }
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL.replace(/\/$/, "");
  }
  if (isAbsoluteHttpUrl(process.env.NEXT_PUBLIC_API_URL)) {
    return process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "");
  }

  // 2. Production GCP Cloud Run deployment (jsgsmile.in)
  // jsgsmile.in is pointed to GCP deployment only in production (not in Vercel)
  if (
    !process.env.VERCEL &&
    (process.env.NEXT_PUBLIC_APP_URL?.includes("jsgsmile.in") ||
     Boolean(process.env.K_SERVICE) ||
     (process.env.NODE_ENV === "production" && !process.env.VERCEL_URL))
  ) {
    return "https://msme-backend-yvkunmwzya-el.a.run.app";
  }

  // 3. Vercel deployments: Map to known stable backend domains (never use per-deployment preview hashes)
  if (process.env.VERCEL || process.env.VERCEL_URL) {
    const vUrl = (process.env.VERCEL_URL || "").toLowerCase();
    const repoSlug = (process.env.VERCEL_GIT_REPO_SLUG || "").toLowerCase();
    const projName = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").toLowerCase();

    // Forked Production repo on Vercel (pugarchdev/MSME_PugArch_Forked)
    if (
      vUrl.includes("forked") ||
      repoSlug.includes("forked") ||
      projName.includes("forked")
    ) {
      return "https://msme-pug-arch-forked-backend.vercel.app";
    }

    // pugarchdev preview deployments
    if (vUrl.includes("pugarchdev") || repoSlug.includes("pugarchdev") || projName.includes("pugarchdev")) {
      return "https://msme-pugarchdev-backend.vercel.app";
    }

    // Testing repo on Vercel (Anandgadge2/MSME_PugArch)
    return "https://msme-pugarch-backend.vercel.app";
  }

  // 4. Production fallback: never return localhost in production or Vercel
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    return "https://msme-pug-arch-forked-backend.vercel.app";
  }

  // 5. Local development fallback
  return (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");
};

const nextConfig: NextConfig = {
  transpilePackages: ["lucide-react"],
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "recharts",
      "motion",
      "clsx",
      "tailwind-merge",
      "sonner",
      "@tanstack/react-query",
    ],
  },
  // The portal does not use next/image. Keep the server-side libvips/sharp
  // optimization endpoint disabled until the patched sharp line is supported
  // by the selected Next.js release.
  images: { unoptimized: true },

  env: {
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF || "",
    // Use /proxy rewrite for same-origin cookies and seamless CSRF when on Vercel or deployed with BACKEND_URL
    ...(process.env.VERCEL_URL || process.env.BACKEND_URL ? { NEXT_PUBLIC_API_URL: "/proxy" } : {}),
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
        ],
      },
      {
        source: "/category-photos/:version/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:all*(png|jpg|jpeg|webp|svg|ico|woff2|woff|ttf|eot)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/proxy/api/files/raw/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
  async rewrites() {
    const backendUrl = getBackendUrl();
    if (backendUrl && backendUrl.startsWith("http")) {
      console.log(
        `[next.config] Rewrites configured: /api/:path* → ${backendUrl}/api/:path*`,
      );
      return {
        beforeFiles: [
          {
            source: "/proxy/:path*",
            destination: `${backendUrl}/:path*`,
          },
          {
            source: "/api/:path*",
            destination: `${backendUrl}/api/:path*`,
          },
        ],
        afterFiles: [],
        fallback: [],
      };
    }
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [],
    };
  },
  turbopack: {
    resolveAlias: {
      "react-router-dom": "./src/lib/next-router-dom.tsx",
    },
  },
  webpack: (config) => {
    // Keep Next.js' default persistent/incremental cache. Disabling it made the
    // catch-all portal route rebuild thousands of modules from scratch.
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "react-router-dom": path.resolve(
        __dirname,
        "src/lib/next-router-dom.tsx",
      ),
      "@": path.resolve(__dirname, "src"),
    };
    return config;
  },
};

export default nextConfig;
