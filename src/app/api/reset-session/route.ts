import { closeSharedLogin, closeSharedMcp } from "@/lib/local-agent";

export const runtime = "nodejs";

// Closes both the agent's MCP and the login Chrome (whichever is alive).
// After this, the next agent run will need a fresh /api/login first.
export async function POST() {
  await closeSharedMcp();
  await closeSharedLogin();
  return Response.json({ ok: true });
}
