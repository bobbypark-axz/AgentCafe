import { z } from "zod";
import { runLocalDeleteAgent } from "@/lib/local-agent";

export const runtime = "nodejs";
export const maxDuration = 300;

const BodySchema = z.object({
  postUrl: z
    .string()
    .url()
    .refine((u) => /cafe\.daum\.net/.test(u), {
      message: "URL must be a cafe.daum.net post URL",
    }),
  cafeUrl: z.string().url().optional(),
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

  if (process.env.LOCAL_AGENT !== "1") {
    return Response.json(
      { error: "delete is local-only for now (set LOCAL_AGENT=1)" },
      { status: 412 },
    );
  }

  const stream = runLocalDeleteAgent(params, req.signal);

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}
