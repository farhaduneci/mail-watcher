// The app config schema. One source for build-time validation, the editor JSON Schema and the
// generated config reference (docs/config-reference.md). Long default text (prompts, alert
// messages, link templates) lives in config/defaults.yaml, not here.
import { z } from "zod";
import { type Channel, secretName } from "../channels/types";

export const BUILTIN_KINDS = ["LINK", "EMAIL", "PHONE", "CODE", "NUMBER", "ADDRESS", "SECRET"] as const;
export const ALERT_KINDS = ["jev", "writer", "forward", "channel", "config", "selftest", "silence"] as const;
export const RESERVED_CATEGORIES = ["uncertain", "error", "default"];
export const DROP_MIN_CONFIDENCE = 0.8;

const name = z.string().regex(/^[a-z0-9_]+$/, "use lowercase letters, digits and _ (it becomes a #tag)");
const kind = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "use an UPPER_CASE placeholder kind");
const globs = z
  .union([z.string(), z.array(z.string()).min(1)])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .describe("A glob (`*` any run, `?` one character, case-insensitive) or a list of globs; any may match.");
const forward = z
  .union([z.literal("inbox"), z.email()], { error: 'must be an email address or "inbox"' })
  .describe('Address to forward to, or "inbox" for `mailbox.inbox`. Must be a verified Email Routing destination.');
const notify = z.array(name).default([]).describe("Channel instances that receive a note.");

const action = z
  .object({ forward: forward.optional(), notify })
  .strict()
  .describe("What happens to the mail. Neither `forward` nor `notify` means drop.");

const category = z
  .object({
    description: z.string().min(1).describe("Plain-language criteria Jev judges the email against."),
    forward: forward.optional(),
    notify,
    min_confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(`Below this Jev probability the watch's \`uncertain\` action applies. Default 0, or ${DROP_MIN_CONFIDENCE} when the category does not forward.`),
    reveal: z.array(kind).default([]).describe("Placeholder kinds whose original values are appended to the note, e.g. [PHONE]."),
  })
  .strict();

const watch = z
  .object({
    name,
    match: z
      .object({ to: globs.optional(), from: globs.optional(), subject: globs.optional() })
      .strict()
      .default({})
      .describe("Every given field must match. An empty match catches all mail."),
    hint: z.string().default("").describe("Guidance for the writer, specific to this watch."),
    fields: z.record(name, z.string()).default({}).describe("Fields the writer extracts: name → description. Stored in the ledger."),
    extract: z.enum(["notify", "always"]).default("notify").describe("`always` runs the writer for fields on every mail, not just notifying mail."),
    categories: z.record(name, category).refine((c) => Object.keys(c).length > 0, "needs at least one category"),
    uncertain: action.default({ forward: "inbox", notify: [] }).describe("Action when Jev's confidence is below the category's min_confidence."),
    on_error: action.default({ forward: "inbox", notify: [] }).describe("Action when Jev fails. Must forward."),
    silence_hours: z.number().positive().optional().describe("Alert when this watch gets no mail for this many hours."),
  })
  .strict();

const writeModel = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("workers-ai"),
      model: z.string().min(1).describe("Workers AI model id, e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast."),
      max_tokens: z.number().int().positive().default(400),
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai-compatible"),
      base_url: z.url().describe("Base URL; `/chat/completions` is appended."),
      model: z.string().min(1),
      key_secret: secretName().describe("Name of the secret holding the API key."),
      max_tokens: z.number().int().positive().default(400),
    })
    .strict(),
]);

const customDetector = z
  .object({
    kind: kind.describe("Placeholder kind; the text becomes `[KIND]`."),
    pattern: z.string().min(1).describe("JavaScript regex source. Avoid nested quantifiers (CPU budget)."),
    flags: z.string().regex(/^[imsu]*$/).default("i"),
    context: z.array(z.string()).default([]).describe("Only redact when one of these words is within `window` characters."),
    window: z.number().int().positive().default(40),
    validator: z.enum(["luhn", "mod97"]).optional(),
    score: z.number().min(0).max(1).default(0.7).describe("Overlap tie-breaker; higher wins."),
  })
  .strict();

const detectors = z
  .object(Object.fromEntries(BUILTIN_KINDS.map((k) => [k.toLowerCase(), z.boolean().default(true)])) as Record<
    Lowercase<(typeof BUILTIN_KINDS)[number]>,
    z.ZodDefault<z.ZodBoolean>
  >)
  .strict()
  .default({ link: true, email: true, phone: true, code: true, number: true, address: true, secret: true });

/** The schema, given the registered channel types. */
export function configSchema(channels: readonly Channel[]) {
  const [first, ...rest] = channels.map((c) => c.settingsSchema.extend({ type: z.literal(c.type) }));
  const instance = rest.length ? z.discriminatedUnion("type", [first, ...rest] as never) : first;

  return z
    .object({
      mailbox: z
        .object({
          inbox: z.email().describe("Main inbox. Must be a verified Email Routing destination."),
          link: z.string().describe("Mailbox link template. {message_id}, {authuser} and {subject} are URL-encoded."),
          search: z.string().describe("Fallback link template when the mail has no Message-ID."),
          authuser: z.string().default("0").describe("Gmail account (index or address) the link opens."),
        })
        .strict(),
      models: z
        .object({
          classify: z
            .object({
              url: z.url().default("https://api.typesafe.ai/v1/systemone"),
              model: z.string().default("jev-latest"),
              key_secret: secretName().default("TYPESAFE_API_KEY"),
            })
            .strict()
            .default({ url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", key_secret: "TYPESAFE_API_KEY" })
            .describe("Jev (TypeSafe), the only classifier."),
          write: writeModel.describe("Model that writes notes, extracts fields and writes the digest."),
        })
        .strict(),
      prompts: z
        .object({
          classify: z.string().describe("Jev instructions. Placeholders: {watch}, {hint}."),
          write: z.string().describe("Writer prompt. Placeholders: {watch}, {category}, {description}, {hint}, {fields}, {from}, {subject}, {body}."),
          digest: z.string().describe("Digest prompt. Placeholders: {days}, {stats}, {subjects}."),
        })
        .strict(),
      redact: z
        .object({
          detectors,
          phone_regions: z.array(z.string().regex(/^[A-Z]{2}$/)).describe("Regions tried for phone numbers written without +."),
          custom: z.array(customDetector).default([]),
          body_cap: z.number().int().positive().default(20000).describe("Characters of body kept (CPU budget)."),
        })
        .strict(),
      channels: z.record(name, instance).default({}).describe("Named channel instances: { type, ...settings }."),
      watches: z.array(watch).min(1).describe("Ordered; the first matching watch wins."),
      default: action.default({ forward: "inbox", notify: [] }).describe("Action for mail matching no watch."),
      alerts: z
        .object({
          channels: z.array(name).default([]),
          throttle_minutes: z.number().positive().default(60).describe("At most one alert per kind per window."),
          messages: z.object(Object.fromEntries(ALERT_KINDS.map((k) => [k, z.string()])) as Record<(typeof ALERT_KINDS)[number], z.ZodString>).strict(),
        })
        .strict(),
      schedules: z
        .object({
          selftest: z.string().optional().describe("Cron for the self-test and silence check."),
          digest: z.string().optional().describe("Cron for the digest."),
          digest_channels: z.array(name).default([]),
          digest_days: z.number().int().positive().default(7),
        })
        .strict()
        .default({ digest_channels: [], digest_days: 7 }),
      selftest: z
        .object({
          watch: name.optional().describe("Watch whose categories the sample is classified against. Default: the first."),
          from: z.string(),
          subject: z.string(),
          body: z.string(),
          expect: name.optional().describe("Category Jev must pick for the self-test to pass."),
        })
        .strict()
        .describe("The canned email the self-test runs through the pipeline."),
      retain_days: z.number().int().min(0).default(30).describe("Days raw .eml files stay in R2. 0 turns retention off."),
      dashboard: z
        .object({
          access: z
            .object({
              team_domain: z.string().describe("Cloudflare Access team domain, e.g. myteam.cloudflareaccess.com."),
              aud: z.string().describe("Application Audience (AUD) tag."),
            })
            .strict()
            .optional(),
          unprotected: z.boolean().default(false).describe("Serve without checking Access. Only for local development."),
        })
        .strict()
        .default({ unprotected: false })
        .describe("Without `access` (or `unprotected`), the dashboard is off."),
    })
    .strict();
}

type Schema = ReturnType<typeof configSchema>;
export type ChannelInstance = { type: string } & Record<string, unknown>;
export type Config = Omit<z.output<Schema>, "channels"> & { channels: Record<string, ChannelInstance> };
export type Watch = Config["watches"][number];
export type Category = Watch["categories"][string];
export type Action = Watch["uncertain"];
export type AlertKind = (typeof ALERT_KINDS)[number];
