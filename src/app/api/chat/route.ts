import { z } from "zod";
import { runLocalChatAgent } from "@/lib/local-agent";

export const runtime = "nodejs";
export const maxDuration = 600;

const BodySchema = z.object({
  message: z.string().min(1).max(4000),
  cafeUrl: z.string().url().refine((u) => /daum\.net/.test(u), {
    message: "URL must be a daum.net URL",
  }),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
      }),
    )
    .max(20)
    .optional(),
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

  const stream = runLocalChatAgent(params, req.signal);

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
