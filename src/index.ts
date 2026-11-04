import type { Env } from "./env";
import { handleRefresh } from "./refresh";
import { run } from "./run";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/refresh" && request.method === "POST") {
      return handleRefresh(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    await run(env);
  },
} satisfies ExportedHandler<Env>;
