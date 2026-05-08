import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles a self-contained `.next/standalone/server.js`
  // that the Electron main process spawns at runtime — see electron/main.cjs.
  output: "standalone",
  // Electron loads the dev server from 127.0.0.1; whitelist it so HMR/Turbopack
  // websocket isn't blocked by Next's cross-origin dev guard.
  allowedDevOrigins: ["127.0.0.1"],
  // Playwright resolves its driver/browser paths relative to the package's
  // own location on disk, which breaks once Next bundles it. Keep it (and
  // playwright-core, which the @playwright/mcp CLI requires) out of the
  // standalone bundle and let Node resolve them from the packaged
  // `app/node_modules/` we ship via electron-builder extraResources.
  serverExternalPackages: ["playwright", "playwright-core", "@playwright/mcp"],
  // Next's standalone tracer otherwise sweeps in massive devDeps it doesn't
  // need — most painfully `electron/` itself (~240 MB of prebuilt runtime)
  // simply because the package exists in node_modules. None of these are
  // actually loaded by the server: electron only runs in the main process
  // outside Next, and electron-builder ships its own copy. Excluding them
  // here cuts the .dmg from ~300 MB to ~130 MB.
  // NOTE: playwright + playwright-core MUST be traced into standalone even
  // though they're listed in serverExternalPackages — Turbopack's external-
  // module resolver maps them through a hashed name (`playwright-<hash>`) and
  // expects to find the package directly inside `.next/standalone/node_modules/`.
  // Excluding them here triggers ERR_MODULE_NOT_FOUND on the very first Playwright
  // import (e.g., POST /api/login → 500).
  outputFileTracingExcludes: {
    "*": [
      "node_modules/electron/**",
      "node_modules/electron-builder/**",
      "node_modules/app-builder-lib/**",
      "node_modules/@electron/**",
      "node_modules/dmg-builder/**",
      "node_modules/typescript/**",
      "node_modules/eslint/**",
      "node_modules/eslint-config-next/**",
      "node_modules/@types/**",
      "node_modules/@playwright/mcp/**",
    ],
  },
  turbopack: {
    // Silences the "multiple lockfiles detected" warning — pin the root here.
    root: __dirname,
  },
};

export default nextConfig;
