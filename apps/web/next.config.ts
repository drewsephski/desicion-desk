import type { NextConfig } from "next";
import { resolve } from "node:path";

// Model and scraper keys live in the repository root `.env.local`, which `next dev apps/web` does not read on its own.
for (const root of [process.cwd(), resolve(process.cwd(), "../..")]) {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(resolve(root, file));
    } catch {
      // Optional file.
    }
  }
}

const eveDevOrigin = process.env.EVE_DEV_ORIGIN;

const nextConfig: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  // `pnpm dev:local` runs `eve dev` beside Next.js; this proxies the agent routes to it.
  // `vercel dev` and deployments route `/eve/*` to the eve service before Next.js sees it.
  ...(eveDevOrigin
    ? { rewrites: async () => [{ source: "/eve/:path*", destination: `${eveDevOrigin}/eve/:path*` }] }
    : {}),
};

export default nextConfig;
