export const runtime = "nodejs";

// Cafe creation requires Daum's multi-step setup wizard which the local
// agent does not yet implement. Use the create cafe page in your browser
// directly, or open the issue to add a runLocalCafeAgent.
export async function POST() {
  return Response.json(
    {
      error:
        "cafe creation is not supported in local mode. Open https://cafe.daum.net/_create to make a cafe in your browser.",
    },
    { status: 501 },
  );
}
