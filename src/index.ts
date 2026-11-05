import type { Env } from "./env";
import { syncRepos } from "./repos";
import { run } from "./run";
import { handleSync } from "./sync";

/** Must match the second cron in wrangler.jsonc; offset from the Infra cron so the two never share Notion's rate limit. */
export const REPOS_CRON = "7,37 * * * *";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/sync" && request.method === "POST") {
      return handleSync(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env) {
    if (controller.cron === REPOS_CRON) await syncRepos(env);
    else await run(env);
  },
} satisfies ExportedHandler<Env>;
