import { runSync } from "./sync";
import { handleReauth, handleCallback } from "./auth";
import { handleStatus } from "./status";
import { handleUI, handleUISync } from "./ui";
import type { Env } from "./types";

async function startSync(env: Env): Promise<void> {
  const moreWork = await runSync(env);
  if (moreWork) {
    console.log("[sync] More work remaining — queuing next run");
    await env.SYNC_QUEUE.send({});
  } else {
    console.log("[sync] All done");
  }
}

export default {
  // Cron trigger.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(startSync(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Instruct crawlers not to index anything on this worker.
    const noIndex = (res: Response): Response => {
      const r = new Response(res.body, res);
      r.headers.set("X-Robots-Tag", "noindex, nofollow");
      return r;
    };

    // OAuth redirect flow — no ADMIN_SECRET required (browser redirect).
    // CSRF protection is handled internally via a KV-stored state token.
    if (pathname === "/reauth" && request.method === "GET") {
      return noIndex(await handleReauth(request, env));
    }
    if (pathname === "/callback" && request.method === "GET") {
      return noIndex(await handleCallback(request, env));
    }

    // UI dashboard — token-authenticated via query param (SYNC_TOKEN).
    if (pathname === "/ui" && request.method === "GET") {
      return noIndex(await handleUI(request, env));
    }
    if (pathname === "/ui" && request.method === "POST") {
      return noIndex(await handleUISync(request, env, ctx));
    }

    // All other routes require ADMIN_SECRET.
    if (request.headers.get("Authorization") !== `Bearer ${env.ADMIN_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (pathname === "/status" && request.method === "GET") {
      return noIndex(await handleStatus(request, env));
    }

    if (pathname === "/sync" && request.method === "POST") {
      ctx.waitUntil(startSync(env));
      return noIndex(new Response("Sync started", { status: 202 }));
    }

    return noIndex(new Response("Not found", { status: 404 }));
  },

  // Queue consumer — processes one message at a time, chains via queue if more work remains.
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    batch.ackAll();
    ctx.waitUntil(startSync(env));
  },
} satisfies ExportedHandler<Env>;
