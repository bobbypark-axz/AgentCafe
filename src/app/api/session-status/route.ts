import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";

const KAKAO_AUTH_COOKIES = ["_kawlt", "_karmt", "_KHAID"] as const;

export async function GET() {
  const profileDir =
    process.env.DAUM_PROFILE_DIR ??
    path.join(os.homedir(), ".agent-cafe-profile");
  const storageStatePath = path.join(profileDir, "storage-state.json");

  try {
    const s = await stat(storageStatePath);
    if (!s.isFile()) {
      return Response.json({ ready: false, reason: "no-storage-state" });
    }
    const buf = await readFile(storageStatePath, "utf8");
    const state = JSON.parse(buf) as { cookies?: Array<{ name?: string }> };
    const cookies = state.cookies ?? [];
    const ready = cookies.some(
      (c) =>
        typeof c.name === "string" &&
        (KAKAO_AUTH_COOKIES as readonly string[]).includes(c.name),
    );
    return Response.json({
      ready,
      reason: ready ? null : "no-auth-cookies",
      cookieCount: cookies.length,
    });
  } catch {
    return Response.json({ ready: false, reason: "no-storage-state" });
  }
}
