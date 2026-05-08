/**
 * electron-builder afterPack hook — ad-hoc sign the macOS .app.
 *
 * Without ANY signature (not even ad-hoc), macOS Sequoia+ Gatekeeper hangs
 * indefinitely on "검사중" while it tries to fetch a notarization ticket
 * from Apple's servers. An ad-hoc signature gives the bundle a CDHash so
 * Gatekeeper fails fast and shows the standard "unidentified developer"
 * dialog instead — recipients can then "Open Anyway" from System Settings.
 *
 * This isn't notarization (no Apple Developer ID required), just a local
 * signature with the placeholder identity `-` (codesign's ad-hoc shortcut).
 */
"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // --force lets us re-sign over electron-builder's no-op signing pass.
  // --deep walks helpers + frameworks so every nested binary is signed too.
  // --sign - is codesign's ad-hoc identity.
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    { stdio: "inherit" },
  );
  console.log(`[after-pack] ad-hoc signed ${appPath}`);
};
