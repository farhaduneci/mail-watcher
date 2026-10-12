// POSTs the note as JSON. An optional bearer token comes from a secret.
import { z } from "zod";
import { type Channel, need, secretName } from "./types";

const settingsSchema = z
  .object({
    url: z.url().describe("Endpoint that receives the note as a JSON POST."),
    token_secret: secretName().optional().describe("Name of a secret sent as `Authorization: Bearer <value>`."),
  })
  .strict();

const webhook: Channel<z.infer<typeof settingsSchema>> = {
  type: "webhook",
  settingsSchema,
  render(note, settings, secrets) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (settings.token_secret) headers.authorization = `Bearer ${need(secrets, settings.token_secret)}`;
    return { url: settings.url, init: { method: "POST", headers, body: JSON.stringify(note) } };
  },
};

export default webhook;
