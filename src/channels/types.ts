import { z } from "zod";

/** The structured notification handed to a channel. Channels render it in their native format. */
export interface Note {
  text: string;
  link?: { url: string; label: string };
  /** Original values of revealed placeholder kinds, e.g. { PHONE: ["+90 532 123 45 67"] }. */
  reveals: Record<string, string[]>;
  tags: string[];
  watch: string;
  category: string;
  subject: string;
}

/** An HTTP request a channel would make. Self-tests render it without sending. */
export interface Rendered {
  url: string;
  init: RequestInit;
}

/** Looks up a secret by the name the config references. */
export type Secrets = (name: string) => string | undefined;

/**
 * A channel type. Drop a file exporting one of these as default into src/channels/ and the build
 * registers it. `settingsSchema` validates an instance's settings at build time; keys ending in
 * `_secret` hold secret names, never secret values.
 */
export interface Channel<S = any> {
  type: string;
  settingsSchema: z.ZodObject<any>;
  render(note: Note, settings: S, secrets: Secrets): Rendered;
}

/** Sends a note through a channel; throws with a short reason on failure. */
export async function send<S>(channel: Channel<S>, note: Note, settings: S, secrets: Secrets): Promise<void> {
  const { url, init } = channel.render(note, settings, secrets);
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${channel.type} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** A config value that names a Worker secret (set with `wrangler secret put`). */
export const secretName = () => z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must be an UPPER_SNAKE_CASE secret name");

/** Reads a secret or throws, so a missing secret fails loudly. */
export function need(secrets: Secrets, name: string): string {
  const value = secrets(name);
  if (!value) throw new Error(`secret ${name} is not set`);
  return value;
}
