// Builds notes and hands them to channels. Code, not the LLM, adds the link, reveals and tags.
import { CHANNELS } from "./channels/registry";
import { type Channel, type Note, type Secrets, send } from "./channels/types";
import { errorText } from "./errors";
import type { Config } from "./config/schema";
import { fillUrl } from "./template";

const byType = new Map<string, Channel>(CHANNELS.map((c) => [c.type, c]));

export function channelOf(type: string): Channel {
  const channel = byType.get(type);
  if (!channel) throw new Error(`no channel type "${type}"`);
  return channel;
}

/** Opens the exact email by Message-ID, else a subject search. */
export function mailboxLink(config: Config, mail: { messageId: string; subject: string }): Note["link"] {
  const vars = { message_id: mail.messageId, subject: mail.subject, authuser: config.mailbox.authuser };
  const url = fillUrl(mail.messageId ? config.mailbox.link : config.mailbox.search, vars);
  return { url, label: mail.subject || config.texts.no_subject };
}

/** A note; tags default to `#watch #category`, and nothing is revealed unless asked. */
export function makeNote(n: Pick<Note, "text" | "watch" | "category"> & Partial<Note>): Note {
  return { reveals: {}, tags: [n.watch, n.category], subject: "", ...n };
}

/** The `name: result` entries that are not "ok". */
export const failures = (results: Record<string, string>): [string, string][] => Object.entries(results).filter(([, r]) => r !== "ok");

/** Sends to each named channel instance. Returns "ok" or the error per instance. */
export async function deliver(config: Config, secrets: Secrets, note: Note, names: string[]): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  await Promise.all(
    names.map(async (name) => {
      try {
        const { type, ...settings } = config.channels[name];
        await send(channelOf(type), note, settings, secrets);
        results[name] = "ok";
      } catch (e) {
        results[name] = `error: ${errorText(e, 300)}`;
      }
    }),
  );
  return Object.fromEntries(names.map((n) => [n, results[n]]));
}
