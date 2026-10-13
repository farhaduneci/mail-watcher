// Alerts about the watcher's own failures, throttled to one sent alert per kind per window.
// Every alert lands in D1, including throttled ones and alerts whose channel failed.
import type { Note } from "./channels/types";
import type { AlertKind, Config } from "./config/schema";
import { deliver } from "./notify";
import { secretsOf } from "./secrets";
import { fill } from "./template";

export interface Problem {
  kind: AlertKind;
  detail: string;
}

export async function alert(config: Config, env: Env, problem: Problem, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - config.alerts.throttle_minutes * 60_000).toISOString();
  const recent = await env.DB.prepare("SELECT 1 FROM alerts WHERE kind = ? AND sent = 'sent' AND at > ? LIMIT 1")
    .bind(problem.kind, cutoff)
    .first();
  let sent = "throttled";
  if (!recent) {
    const note: Note = {
      text: fill(config.alerts.messages[problem.kind], { detail: problem.detail }),
      reveals: {},
      tags: ["mail_watcher", "alert", problem.kind],
      watch: "mail_watcher",
      category: problem.kind,
      subject: "",
    };
    const results = config.alerts.channels.length ? await deliver(config, secretsOf(env), note, config.alerts.channels) : {};
    const failed = Object.entries(results).filter(([, r]) => r !== "ok");
    sent = !config.alerts.channels.length
      ? "failed: no alert channels"
      : failed.length
        ? `failed: ${failed.map(([n, r]) => `${n}: ${r}`).join("; ")}`.slice(0, 1000)
        : "sent";
  }
  await env.DB.prepare("INSERT INTO alerts (at, kind, detail, sent) VALUES (?, ?, ?, ?)")
    .bind(now.toISOString(), problem.kind, problem.detail.slice(0, 1000), sent)
    .run();
}

/** One alert per kind; details of the same kind are joined. */
export async function raise(config: Config, env: Env, problems: Problem[], now = new Date()): Promise<void> {
  const byKind = new Map<AlertKind, string[]>();
  for (const p of problems) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p.detail]);
  for (const [kind, details] of byKind) {
    try {
      await alert(config, env, { kind, detail: details.join("; ") }, now);
    } catch (e) {
      console.error("mail-watcher: alert failed", kind, details, e);
    }
  }
}
