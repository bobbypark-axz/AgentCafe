import { z } from "zod";
import { getDaumSessionBlobUrl } from "@/lib/blob";
import { runCafeAgent } from "@/lib/sandbox";

export const runtime = "nodejs";
export const maxDuration = 300;

const BodySchema = z.object({
  cafeName: z.string().min(2).max(40),
  cafeDescription: z.string().max(400).optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  category: z.string().max(40).optional(),
});

export async function POST(req: Request) {
  let params: z.infer<typeof BodySchema>;
  try {
    params = BodySchema.parse(await req.json());
  } catch (err) {
    return Response.json(
      {
        error: "invalid request body",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }

  // Cafe creation is sandbox-only — there is no local Chromium profile path
  // for it (the local-agent lib only exposes post + moderate + delete).
  if (process.env.LOCAL_AGENT === "1") {
    return Response.json(
      {
        error:
          "cafe creation is not available in LOCAL_AGENT mode; deploy to Vercel or unset LOCAL_AGENT",
      },
      { status: 501 },
    );
  }

  let sessionBlobUrl: string;
  try {
    sessionBlobUrl = await getDaumSessionBlobUrl();
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 412 },
    );
  }

  const stream = runCafeAgent(
    { ...params, sessionBlobUrl },
    req.signal,
  );

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
