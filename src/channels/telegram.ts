// Telegram Bot API, HTML parse mode. The mailbox link becomes an anchor on the subject.
import { z } from "zod";
import { escapeHtml as esc } from "../html";
import { type Channel, need, secretName } from "./types";

const settingsSchema = z
  .object({
    chat_id: z.string().min(1).describe("Chat that receives the notes (a user, group or channel id)."),
    token_secret: secretName().describe("Name of the secret holding the bot token from @BotFather."),
  })
  .strict();

const hashtag = (s: string) => `#${s.replace(/[^\p{L}\p{N}_]/gu, "_")}`;

export function telegramHtml(note: Parameters<Channel["render"]>[0]): string {
  const lines = [esc(note.text)];
  if (note.link) lines.push(`<a href="${esc(note.link.url)}">${esc(note.link.label)}</a>`);
  for (const [kind, values] of Object.entries(note.reveals)) {
    if (values.length) lines.push(`${esc(kind)}: ${values.map((v) => `<code>${esc(v)}</code>`).join(", ")}`);
  }
  if (note.tags.length) lines.push(note.tags.map(hashtag).join(" "));
  return lines.join("\n\n");
}

const telegram: Channel<z.infer<typeof settingsSchema>> = {
  type: "telegram",
  settingsSchema,
  render(note, settings, secrets) {
    return {
      url: `https://api.telegram.org/bot${need(secrets, settings.token_secret)}/sendMessage`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: settings.chat_id,
          text: telegramHtml(note),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
      },
    };
  },
};

export default telegram;
