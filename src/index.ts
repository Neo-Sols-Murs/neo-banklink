import { runSync } from "./sync";
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
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(startSync(env));
  },

  // Manual HTTP trigger — protected by ADMIN_SECRET.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get("Authorization") !== `Bearer ${env.ADMIN_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    ctx.waitUntil(startSync(env));
    return new Response("Sync started", { status: 202 });
  },

  // Queue consumer — processes one message at a time, chains via queue if more work remains.
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    batch.ackAll();
    ctx.waitUntil(startSync(env));
  },
} satisfies ExportedHandler<Env>;
