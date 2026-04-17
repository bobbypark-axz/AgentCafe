import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Silences the "multiple lockfiles detected" warning — pin the root here.
    root: __dirname,
  },
  // The agent script + its package.json live outside of any imported module
  // (we read them with fs.readFile at request time), so Next.js's build
  // tracer can't discover them. Include them explicitly for the API route
  // that actually reads them.
  outputFileTracingIncludes: {
    "/api/create-cafe": [
      "./sandbox/agent.mjs",
      "./sandbox/post-agent.mjs",
      "./sandbox/package.json",
    ],
    "/api/auth": [
      "./sandbox/login-helper.mjs",
      "./sandbox/package.json",
    ],
  },
  // @vercel/sandbox is Node-only; keep it out of any edge bundles.
  serverExternalPackages: ["@vercel/sandbox", "@vercel/blob"],
};

export default nextConfig;
