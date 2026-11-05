import type { Env } from "./env";
import { handleSync } from "./sync";
import { run } from "./run";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/sync" && request.method === "POST") {
      return handleSync(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    await run(env);
  },
} satisfies ExportedHandler<Env>;
