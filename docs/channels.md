# Channels

A channel delivers notes. Each instance in `channels:` names a type and its settings:

```yaml
channels:
  phone:
    type: telegram
    chat_id: "123456789"
    token_secret: TELEGRAM_BOT_TOKEN
  tracker:
    type: webhook
    url: https://tracker.example.com/mail
    token_secret: TRACKER_TOKEN # optional
```

## Built in

### telegram

Sends with the Bot API in HTML parse mode: the note text, the subject as a link to the email,
revealed values in `<code>`, and the tags as hashtags. Create a bot with @BotFather, send it a
message, and read the chat id from `https://api.telegram.org/bot<token>/getUpdates`.

| Setting | |
|---|---|
| `chat_id` | user, group or channel id |
| `token_secret` | name of the secret holding the bot token |

### webhook

POSTs the note as JSON (see the note shape in [concepts.md](concepts.md#note)).

| Setting | |
|---|---|
| `url` | endpoint |
| `token_secret` | optional; sent as `Authorization: Bearer <value>` |

## Writing a channel

Drop one TypeScript file into `src/channels/`. The build scans the folder and generates the
registry, so there is no wiring. The file default-exports a `Channel`:

```ts
// src/channels/ntfy.ts
import { z } from "zod";
import { type Channel, need, secretName } from "./types";

const settingsSchema = z
  .object({
    topic: z.string().min(1).describe("ntfy topic"),
    token_secret: secretName().optional(),
  })
  .strict();

const ntfy: Channel<z.infer<typeof settingsSchema>> = {
  type: "ntfy",
  settingsSchema,
  render(note, settings, secrets) {
    const headers: Record<string, string> = { title: note.subject, tags: note.tags.join(",") };
    if (note.link) headers.click = note.link.url;
    if (settings.token_secret) headers.authorization = `Bearer ${need(secrets, settings.token_secret)}`;
    return { url: `https://ntfy.sh/${settings.topic}`, init: { method: "POST", headers, body: note.text } };
  },
};

export default ntfy;
```

- `settingsSchema` is a zod object. The build validates every instance of the type against it, so
  config mistakes fail the build, and the generated JSON Schema and config reference pick it up.
- Keys ending in `_secret` hold secret names. `npm run setup` prompts for them; `need()` reads one
  at send time and fails loudly when it is missing.
- `render` returns the HTTP request. The Worker sends it; the self-test only renders it, which
  checks settings and secrets without sending anything.
- Render `note.reveals` and `note.link` in whatever form the channel supports natively.

Add a test in `test/worker/` that delivers an email through a watch notifying the new channel and
asserts on the request it made.
