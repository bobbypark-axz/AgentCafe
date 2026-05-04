import { z } from "zod";
import { getDaumSessionBlobUrl } from "@/lib/blob";
import { runLocalPostAgent } from "@/lib/local-agent";
import { runSandboxPostAgent } from "@/lib/sandbox";

export const runtime = "nodejs";
export const maxDuration = 300;

const BodySchema = z.object({
  cafeUrl: z.string().url().refine((u) => /daum\.net/.test(u), {
    message: "URL must be a daum.net URL",
  }),
  topicHint: z.string().max(200).optional(),
  length: z.enum(["short", "medium", "long"]).default("medium"),
  tone: z.string().max(40).optional(),
  // Login fallback: when storageState is expired, agent types these into the
  // Daum login form. 2FA still requires user interaction via the live iframe.
  daumEmail: z.string().email().optional(),
  daumPassword: z.string().min(1).max(200).optional(),
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

  const isLocal = process.env.LOCAL_AGENT === "1";

  let sessionBlobUrl: string | null = null;
  if (!isLocal) {
    // Sandbox path needs storageState from Blob (each microVM is fresh).
    // Local path uses a persistent Chromium profile dir instead — no Blob.
    try {
      sessionBlobUrl = await getDaumSessionBlobUrl();
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 412 },
      );
    }
  }

  const stream = isLocal
    ? runLocalPostAgent(params, req.signal)
    : runSandboxPostAgent(
        { ...params, sessionBlobUrl: sessionBlobUrl! },
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
