import type { Env } from "./env";
import { run } from "./run";

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    await run(env);
  },
} satisfies ExportedHandler<Env>;
