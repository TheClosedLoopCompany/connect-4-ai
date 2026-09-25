// Local dev server (Bun). Bun loads .env automatically.
import { handleApi } from "./api";

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const { pathname } = new URL(req.url);
    // Bot protection is production-only (worker.ts), even if .env has Turnstile keys.
    if (pathname.startsWith("/api/")) return handleApi(req, { ...process.env, TURNSTILE_SITE_KEY: undefined });
    const file = Bun.file(`public${pathname === "/" ? "/index.html" : pathname}`);
    return (await file.exists()) && !pathname.includes("..") ? new Response(file, { headers: { "Cache-Control": "no-cache" } }) : new Response("Not found", { status: 404 });
  },
});

console.log(`Connect 4 running on http://localhost:${process.env.PORT ?? 3000}`);
