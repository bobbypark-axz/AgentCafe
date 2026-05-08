import { z } from "zod";
import { runLocalPostAgent } from "@/lib/local-agent";

export const runtime = "nodejs";
export const maxDuration = 300;

const BodySchema = z.object({
  cafeUrl: z.string().url().refine((u) => /daum\.net/.test(u), {
    message: "URL must be a daum.net URL",
  }),
  topicHint: z.string().max(200).optional(),
  length: z.enum(["short", "medium", "long"]).default("medium"),
  tone: z.string().max(40).optional(),
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

  const stream = runLocalPostAgent(params, req.signal);
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
