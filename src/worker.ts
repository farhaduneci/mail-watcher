// The Worker, built from a bundled app config: `email` routes mail, `scheduled` runs the
// self-test, silence check and digest, `fetch` serves the read-only dashboard.
import type { Config } from "./config/schema";
import { act, finish, handle } from "./email";

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
  };
}
