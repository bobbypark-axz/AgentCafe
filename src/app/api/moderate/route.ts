import { z } from "zod";
import { getDaumSessionBlobUrl } from "@/lib/blob";
import { runLocalModerateAgent } from "@/lib/local-agent";
import { runSandboxModerateAgent } from "@/lib/sandbox";

export const runtime = "nodejs";
export const maxDuration = 300;

const BodySchema = z.object({
  cafeUrl: z
    .string()
    .url()
    .refine((u) => /daum\.net/.test(u), {
      message: "URL must be a daum.net URL",
    }),
  boardHint: z.string().max(60).optional(),
  keywords: z.array(z.string().min(1).max(40)).max(50).default([]),
  action: z.enum(["3일 정지", "7일 정지", "영구 차단"]).default("3일 정지"),
  dryRun: z.boolean().default(true),
  maxPosts: z.number().int().min(1).max(30).default(10),
  maxActions: z.number().int().min(0).max(20).default(5),
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
    ? runLocalModerateAgent(params, req.signal)
    : runSandboxModerateAgent(
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
