import { list } from "@vercel/blob";

const DEFAULT_KEY = "sessions/daum-storage-state.json";

/**
 * Returns the public Blob URL for the seeded Daum storageState.
 *
 * The URL itself acts as the capability — it contains a random token that's
 * only visible to callers with `BLOB_READ_WRITE_TOKEN`. We hand this URL to
 * the Vercel Sandbox agent, which does a plain `fetch()` against it.
 */
export async function getDaumSessionBlobUrl(): Promise<string> {
  const prefix = process.env.DAUM_SESSION_BLOB_KEY ?? DEFAULT_KEY;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set. Create a Blob store in the Vercel dashboard and run `vercel env pull .env.local`.",
    );
  }
  const { blobs } = await list({ prefix, limit: 1, token });
  if (blobs.length === 0) {
    throw new Error(
      `No session blob found at "${prefix}". Run \`npm run seed\` locally to capture a Daum login first.`,
    );
  }
  return blobs[0].url;
}
