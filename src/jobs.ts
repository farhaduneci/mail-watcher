// Scheduled jobs: the self-test (with the silence check and raw-retention cleanup) and the digest.
import { alert } from "./alerts";
import type { Config } from "./config/schema";
import { redactState } from "./email";
import { classify } from "./jev";
import { recordRun } from "./ledger";
import { channelOf, deliver, mailboxLink } from "./notify";
import { redact, reveals } from "./redact";
import { secretsOf } from "./secrets";
import { fill } from "./template";
import { notePrompt, write } from "./writer";

const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

/** The canned sample through redact → Jev → writer → a dry render for every channel instance. */
async function runSelftest(config: Config, env: Env): Promise<string> {
  const sample = config.selftest;
  const watch = config.watches.find((w) => w.name === (sample.watch ?? config.watches[0].name))!;
  const secrets = secretsOf(env);
  const { state, spans } = redactState(config, { from: sample.from, name: "", subject: sample.subject, messageId: "selftest@mail-watcher", body: sample.body });

  const verdict = await classify(config, secrets, watch, state);
  if (sample.expect && verdict.choice !== sample.expect) throw new Error(`expected "${sample.expect}", got "${verdict.choice}"`);
  const category = watch.categories[verdict.choice];
  let written;
  try {
    written = await write(config, env.AI, secrets, notePrompt(config, watch, verdict.choice, category.description, state), Object.keys(watch.fields));
  } catch (e) {
    throw new Error(`writer: ${short(e)}`);
  }
  const note = {
    text: written.message,
    link: mailboxLink(config, { messageId: "selftest@mail-watcher", subject: sample.subject }),
    reveals: reveals(spans, category.reveal),
    tags: [watch.name, verdict.choice],
    watch: watch.name,
    category: verdict.choice,
    subject: sample.subject,
  };
  for (const [name, { type, ...settings }] of Object.entries(config.channels)) {
    try {
      const { url } = channelOf(type).render(note, settings, secrets);
      new URL(url);
    } catch (e) {
      throw new Error(`channel ${name}: ${short(e)}`);
    }
  }
  return `${watch.name}: ${verdict.choice} (${verdict.probabilities[verdict.choice] ?? "?"})`;
}

export async function selftest(config: Config, env: Env, now: Date): Promise<void> {
  try {
    const detail = await runSelftest(config, env);
    await recordRun(env.DB, "selftest", true, detail, now);
  } catch (e) {
    await recordRun(env.DB, "selftest", false, short(e), now);
    await alert(config, env, { kind: "selftest", detail: short(e) }, now);
  }
}

/** Alerts for each watch with silence_hours whose last mail is older than that. */
export async function silence(config: Config, env: Env, now: Date): Promise<void> {
  const quiet: string[] = [];
  const first = await env.DB.prepare("SELECT MIN(at) AS at FROM mail").first<{ at: string | null }>();
  for (const watch of config.watches) {
    if (!watch.silence_hours) continue;
    const last = await env.DB.prepare("SELECT MAX(at) AS at FROM mail WHERE watch = ?").bind(watch.name).first<{ at: string | null }>();
    // A watch that never had mail counts from the first ledger row; an empty ledger is a fresh install.
    const since = last?.at ?? first?.at;
    if (!since) continue;
    const hours = (now.getTime() - Date.parse(since)) / 3600_000;
    if (hours > watch.silence_hours) quiet.push(fill(config.texts.silence_detail, { watch: watch.name, hours: Math.floor(hours), limit: watch.silence_hours }));
  }
  if (quiet.length) await alert(config, env, { kind: "silence", detail: quiet.join("; ") }, now);
}

/** Deletes raw emails older than retain_days. */
export async function prune(config: Config, env: Env, now: Date): Promise<void> {
  if (!env.RAW) return;
  const cutoff = new Date(now.getTime() - config.retain_days * 86400_000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, r2_key FROM mail WHERE r2_key IS NOT NULL AND at < ? LIMIT 1000")
    .bind(cutoff)
    .all<{ id: number; r2_key: string }>();
  if (!results.length) return;
  await env.RAW.delete(results.map((r) => r.r2_key));
  await env.DB.batch(results.map((r) => env.DB.prepare("UPDATE mail SET r2_key = NULL WHERE id = ?").bind(r.id)));
}

/** The digest: per-watch, per-category counts and notable subjects (redacted), written by the LLM. */
export async function digest(config: Config, env: Env, now: Date): Promise<void> {
  const days = config.schedules.digest_days;
  const since = new Date(now.getTime() - days * 86400_000).toISOString();
  const { results: counts } = await env.DB.prepare(
    "SELECT watch, category, COUNT(*) AS n FROM mail WHERE at >= ? GROUP BY watch, category ORDER BY watch IS NULL, watch, category",
  )
    .bind(since)
    .all<{ watch: string | null; category: string; n: number }>();
  const stats: Record<string, Record<string, number>> = {};
  for (const c of counts) (stats[c.watch ?? "default"] ??= {})[c.category] = c.n;

  const { results: notable } = await env.DB.prepare(
    "SELECT watch, category, subject FROM mail WHERE at >= ? AND (action LIKE '%notified%' OR category IN ('uncertain', 'error')) ORDER BY at DESC LIMIT 30",
  )
    .bind(since)
    .all<{ watch: string | null; category: string; subject: string | null }>();
  const subjects = notable.map((r) => `- ${r.watch ?? "default"}/${r.category}: ${redact(r.subject ?? "", config.redact).text}`).join("\n");

  const secrets = secretsOf(env);
  const problems: string[] = [];
  let text: string;
  try {
    const prompt = fill(config.prompts.digest, { days, stats: JSON.stringify(stats), subjects: subjects || "(none)" });
    text = (await write(config, env.AI, secrets, prompt, [])).message;
  } catch (e) {
    problems.push(`writer: ${short(e)}`);
    await alert(config, env, { kind: "writer", detail: `digest: ${short(e)}` }, now);
    const lines = Object.entries(stats).map(([w, cs]) => `${w}: ${Object.entries(cs).map(([c, n]) => `${c} ${n}`).join(", ")}`);
    text = fill(config.texts.digest_fallback, { days, counts: lines.length ? lines.join("\n") : config.texts.digest_empty });
  }

  const note = { text, reveals: {}, tags: ["mail_watcher", "digest"], watch: "mail_watcher", category: "digest", subject: "" };
  const results = await deliver(config, secrets, note, config.schedules.digest_channels);
  const failed = Object.entries(results).filter(([, r]) => r !== "ok").map(([n, r]) => `${n}: ${r}`);
  if (failed.length) {
    problems.push(...failed);
    await alert(config, env, { kind: "channel", detail: `digest: ${failed.join("; ")}` }, now);
  }
  await recordRun(env.DB, "digest", problems.length === 0, problems.join("; ") || `${counts.reduce((s, c) => s + c.n, 0)} mail(s)`, now);
}
