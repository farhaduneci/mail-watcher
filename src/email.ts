// The per-email pipeline: parse → select watch → redact → classify → act, then (in waitUntil)
// notify, ledger and raw retention. Forwarding happens first, so a later failure costs a note or
// a ledger row, never the mail.
import { type Problem, raise } from "./alerts";
import type { Action, Category, Config, Watch } from "./config/schema";
import { classify, type State } from "./jev";
import { insertRow, type MailRow } from "./ledger";
import { type Mail, parseMail, tagOf } from "./mail";
import { selectWatch } from "./match";
import type { Note } from "./channels/types";
import { deliver, mailboxLink } from "./notify";
import { redact, reveals, type Span } from "./redact";
import { notePrompt, write } from "./writer";
import { secretsOf } from "./secrets";

/** What the background stage needs to finish an email. */
export interface Handled {
  config: Config;
  env: Env;
  row: MailRow;
  mail: Mail | null;
  watch: Watch | undefined;
  category: Category | undefined;
  action: Action;
  state: State | null;
  spans: Span[];
  raw: ArrayBuffer;
  problems: Problem[];
  started: number;
}

const append = (error: string | null, more: string) => (error ? `${error}; ${more}` : more);
const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

/** Redacts each part on its own, so spans never cross from one part into another. */
export function redactState(config: Config, mail: Mail): { state: State; spans: Span[] } {
  const from = redact(mail.name ? `${mail.name} <${mail.from}>` : mail.from, config.redact);
  const subject = redact(mail.subject, config.redact);
  const body = redact(mail.body, config.redact);
  return { state: { from: from.text, subject: subject.text, body: body.text }, spans: [...from.spans, ...subject.spans, ...body.spans] };
}

export async function handle(config: Config, message: ForwardableEmailMessage, env: Env): Promise<Handled> {
  const started = performance.now();
  const raw = await new Response(message.raw).arrayBuffer();
  const row: MailRow = {
    at: new Date().toISOString(),
    to_addr: message.to,
    tag: tagOf(message.to),
    from_addr: message.from,
    subject: "",
    message_id: null,
    watch: null,
    category: "default",
    confidence: null,
    probs: null,
    action: "",
    forwarded_to: null,
    fields: null,
    summary: null,
    notified: null,
    cpu_ms: null,
    error: null,
    r2_key: null,
  };
  const h: Handled = { config, env, row, mail: null, watch: undefined, category: undefined, action: config.default, state: null, spans: [], raw, problems: [], started };

  try {
    h.mail = await parseMail(raw, message.from, config.redact.body_cap);
    Object.assign(row, { from_addr: h.mail.from, subject: h.mail.subject, message_id: h.mail.messageId || null });
  } catch (e) {
    row.error = `parse: ${short(e)}`;
  }

  h.watch = selectWatch(config, { to: message.to, from: h.mail?.from ?? message.from, subject: h.mail?.subject ?? "" });
  if (h.watch) {
    row.watch = h.watch.name;
    h.action = h.watch.on_error;
    row.category = "error";
    if (h.mail) {
      try {
        Object.assign(h, redactState(config, h.mail));
        const verdict = await classify(config, secretsOf(env), h.watch, h.state!);
        const category = h.watch.categories[verdict.choice];
        row.confidence = verdict.probabilities[verdict.choice] ?? null;
        row.probs = JSON.stringify(verdict.probabilities);
        if ((row.confidence ?? 0) >= (category.min_confidence ?? 0)) {
          h.category = category;
          h.action = category;
          row.category = verdict.choice;
        } else {
          h.action = h.watch.uncertain;
          row.category = "uncertain";
        }
      } catch (e) {
        row.error = append(row.error, short(e));
        h.problems.push({ kind: "jev", detail: `${h.watch.name}: ${short(e)}` });
      }
    }
  }

  return h;
}

/** Forwards or drops. Throws only when even the inbox refuses the mail. */
export async function act(h: Handled, message: ForwardableEmailMessage): Promise<void> {
  const { row, config } = h;
  const flags: string[] = [];
  if (h.action.forward) {
    const target = h.action.forward === "inbox" ? config.mailbox.inbox : h.action.forward;
    try {
      await message.forward(target);
      row.forwarded_to = target;
    } catch (e) {
      row.error = append(row.error, `forward(${target}): ${short(e)}`);
      h.problems.push({ kind: "forward", detail: `${target}: ${short(e)}` });
      if (target === config.mailbox.inbox) throw e;
      // Usually an unverified destination. The inbox is verified by setup.
      await message.forward(config.mailbox.inbox);
      row.forwarded_to = config.mailbox.inbox;
    }
    flags.push("forwarded");
  } else if (!h.action.notify.length) {
    flags.push("dropped");
  }
  row.action = flags.join(",");
}

/** Writer call (when the action notifies or the watch extracts always), then the note. */
async function notify(h: Handled): Promise<void> {
  const { row, env, config, watch, mail } = h;
  const notifies = h.action.notify.length > 0;
  if (!notifies && !(watch?.extract === "always" && mail)) return;
  if (mail && !h.state) Object.assign(h, redactState(config, mail));

  const secrets = secretsOf(env);
  const fields = Object.keys(watch?.fields ?? {});
  let text = "";
  if (h.state) {
    const prompt = notePrompt(config, watch, row.category, h.category?.description ?? "", h.state);
    try {
      const written = await write(config, env.AI, secrets, prompt, fields);
      text = written.message;
      if (fields.length) row.fields = JSON.stringify(written.fields);
    } catch (e) {
      row.error = append(row.error, `writer: ${short(e)}`);
      h.problems.push({ kind: "writer", detail: short(e) });
    }
  }
  if (!notifies) return;

  const subject = mail?.subject ?? "";
  const note: Note = {
    text: text || subject || "(no subject)",
    link: mailboxLink(config, { messageId: mail?.messageId ?? "", subject }),
    reveals: reveals(h.spans, h.category?.reveal ?? []),
    tags: [watch?.name ?? "default", row.category],
    watch: watch?.name ?? "default",
    category: row.category,
    subject,
  };
  const results = await deliver(config, secrets, note, h.action.notify);
  row.notified = JSON.stringify(results);
  if (text) row.summary = text;
  for (const [name, result] of Object.entries(results)) {
    if (result === "ok") continue;
    row.error = append(row.error, `notify(${name}): ${result}`);
    h.problems.push({ kind: "channel", detail: `${name}: ${result}` });
  }
  if (Object.values(results).includes("ok")) row.action = row.action ? `${row.action},notified` : "notified";
  // A notify-only email whose every channel failed reached neither the mailbox nor the phone.
  else if (!row.action) row.action = "dropped";
}

/** The background stage: notify, raw retention, ledger. */
export async function finish(h: Handled): Promise<void> {
  const { row, env, config } = h;
  try {
    await notify(h);
  } catch (e) {
    row.error = append(row.error, `notify: ${short(e)}`);
  }
  if (env.RAW && config.retain_days > 0) {
    try {
      const key = `raw/${row.at.slice(0, 10)}/${crypto.randomUUID()}.eml`;
      await env.RAW.put(key, h.raw, { httpMetadata: { contentType: "message/rfc822" } });
      row.r2_key = key;
    } catch (e) {
      row.error = append(row.error, `r2: ${short(e)}`);
    }
  }
  row.cpu_ms = Math.round((performance.now() - h.started) * 100) / 100;
  await insertRow(env.DB, row);
  await raise(config, env, h.problems);
}
