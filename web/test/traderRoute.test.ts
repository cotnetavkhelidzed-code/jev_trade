import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { GET } from "../src/app/api/trader/[[...path]]/route";

const savedBinding = process.env.JEV_APP_URL;
const fetchSpy = spyOn(globalThis, "fetch");
afterAll(() => fetchSpy.mockRestore());
afterEach(() => {
  fetchSpy.mockReset();
  if (savedBinding === undefined) delete process.env.JEV_APP_URL;
  else process.env.JEV_APP_URL = savedBinding;
});

const call = (path: string[] = [], signal?: AbortSignal) => GET(
  new Request(`https://dashboard.example/api/trader/${path.join("/")}?view=latest`, { signal }),
  { params: Promise.resolve({ path }) },
);

describe("runtime service binding", () => {
  test("the same handler resolves the injected binding at request time for snapshots and history", async () => {
    for (const [binding, path] of [["https://first.internal/base", []], ["https://second.internal/base/", ["history"]]] as const) {
      process.env.JEV_APP_URL = binding;
      fetchSpy.mockResolvedValueOnce(Response.json({ ok: true }));
      const response = await call([...path]);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const [url, options] = fetchSpy.mock.calls.at(-1)!;
      expect(String(url)).toBe(`${binding.replace(/\/+$/, "")}/${path.join("/")}?view=latest`);
      expect(options).toMatchObject({ cache: "no-store", redirect: "manual" });
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });

  test("SSE is forwarded before the upstream stream closes, with disconnect cancellation", async () => {
    process.env.JEV_APP_URL = "https://app.internal/";
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      cancel() { cancelled = true; },
    });
    fetchSpy.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream", "x-private": "hidden" } }));
    const abort = new AbortController();
    const response = await call(["events"], abort.signal);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.has("x-private")).toBe(false);
    source.enqueue(new TextEncoder().encode("event: ping\ndata: 1\n\n"));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: ping\ndata: 1\n\n");
    await reader.cancel();
    expect(cancelled).toBe(true);
    abort.abort();
    expect(fetchSpy.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  test("missing bindings return 503 without silently using an unrelated backend", async () => {
    delete process.env.JEV_APP_URL;
    expect((await call()).status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("only the three read endpoints can reach the private service", async () => {
    process.env.JEV_APP_URL = "https://app.internal/";
    for (const path of [["orders"], ["history", "other"], ["..", "events"]]) expect((await call(path)).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("upstream redirects and transport errors never expose private URLs", async () => {
    process.env.JEV_APP_URL = "https://app.internal/";
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://app.internal/secret" } }));
    const redirect = await call();
    expect(redirect.status).toBe(502);
    expect(redirect.headers.has("location")).toBe(false);
    fetchSpy.mockRejectedValueOnce(new Error("Cannot connect to https://app.internal/secret"));
    const error = await call();
    expect(error.status).toBe(502);
    expect(await error.text()).not.toContain("app.internal");
  });
});
