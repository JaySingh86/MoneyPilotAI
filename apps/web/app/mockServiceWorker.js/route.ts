// Serves MSW's service worker script at /mockServiceWorker.js, in development only. In production
// `process.env.NODE_ENV` is the constant "production", the branch below is dropped from the bundle,
// and the route just answers 404, so a deployed app never carries or offers the mock worker.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV !== "production") {
    // `next dev` runs from apps/web, where pnpm links the msw package.
    const script = await readFile(
      join(process.cwd(), "node_modules", "msw", "lib", "mockServiceWorker.js"),
      "utf8",
    );
    return new Response(script, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "service-worker-allowed": "/",
      },
    });
  }
  return new Response("Not found", { status: 404 });
}
