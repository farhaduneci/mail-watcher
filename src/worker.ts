// The Worker, built from a bundled app config: `email` routes mail, `scheduled` runs the
// self-test, silence check and digest, `fetch` serves the read-only dashboard.
import type { Config } from "./config/schema";
import { act, finish, handle } from "./email";
import { prune, selftest, silence } from "./jobs";

export function createWorker(config: Config): ExportedHandler<Env> {
  return {
    async email(message, env, ctx) {
      const h = await handle(config, message, env);
      try {
        await act(h, message);
      } finally {
        ctx.waitUntil(finish(h).catch((e) => console.error("mail-watcher: finishing failed", e, h.row)));
      }
    },

    async scheduled(controller, env, ctx) {
      const now = new Date(controller.scheduledTime);
      const jobs: Promise<void>[] = [];
      if (controller.cron === config.schedules.selftest) {
        jobs.push(selftest(config, env, now), silence(config, env, now), prune(config, env, now));
      }
      ctx.waitUntil(Promise.all(jobs.map((j) => j.catch((e) => console.error("mail-watcher: job failed", controller.cron, e)))));
    },
  };
}
