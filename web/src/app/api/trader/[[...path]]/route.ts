/** Public, read-only dashboard API. The app service itself has no public rewrite. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await context.params;
  const endpoint = path.join("/");
  if (path.length > 1 || !["", "history", "events"].includes(endpoint)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Bindings are injected into functions at runtime, never into builds or the browser bundle.
  const binding = process.env.JEV_APP_URL;
  if (!binding) return Response.json({ error: "Trading service binding is unavailable" }, { status: 503 });

  try {
    const target = new URL(endpoint, binding.replace(/\/+$/, "") + "/");
    target.search = new URL(request.url).search;
    const upstream = await fetch(target, {
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
      headers: { accept: endpoint === "events" ? "text/event-stream" : "application/json" },
    });
    // A backend redirect could reveal its private address to the browser.
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return Response.json({ error: "Trading service returned an unexpected redirect" }, { status: 502 });
    }
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store, no-transform",
    });
    if (endpoint === "events") headers.set("x-accel-buffering", "no");
    // Pass the stream through without reading it into memory. Cancellation reaches fetch above.
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return Response.json({ error: "Trading service is unavailable" }, { status: 502 });
  }
}
