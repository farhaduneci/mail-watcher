// The writer: a configurable LLM that turns redacted text into a short note (plus fields), or
// writes the digest. Workers AI or any OpenAI-compatible endpoint.
import { need, type Secrets } from "./channels/types";
import type { Config, Watch } from "./config/schema";
import type { State } from "./jev";
import { fill } from "./template";

export interface Written {
  message: string;
  fields: Record<string, string>;
}

function schemaFor(fields: string[]) {
  return {
    type: "object",
    properties: {
      message: { type: "string" },
      fields: { type: "object", properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])), required: fields, additionalProperties: false },
    },
    required: ["message", "fields"],
    additionalProperties: false,
  };
}

/** Workers AI returns structured output parsed or as a JSON string, depending on the model. */
function parseAnswer(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`answer is not JSON: ${raw.slice(0, 100)}`);
  }
}

async function complete(config: Config, ai: Ai, secrets: Secrets, prompt: string, schema: object): Promise<unknown> {
  const model = config.models.write;
  if (model.provider === "workers-ai") {
    const out = (await ai.run(model.model as keyof AiModels, {
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: model.max_tokens,
    } as never)) as { response?: unknown };
    return parseAnswer(out?.response);
  }
  const res = await fetch(`${model.base_url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${need(secrets, model.key_secret)}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } },
      max_tokens: model.max_tokens,
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  return parseAnswer(body.choices?.[0]?.message?.content);
}

/** Runs the prompt and returns the note text and the requested fields. Throws on any bad answer. */
export async function write(config: Config, ai: Ai, secrets: Secrets, prompt: string, fields: string[]): Promise<Written> {
  const answer = (await complete(config, ai, secrets, prompt, schemaFor(fields))) as Partial<Written> | undefined;
  if (typeof answer?.message !== "string" || !answer.message.trim()) {
    throw new Error(`answer has no message: ${JSON.stringify(answer).slice(0, 200)}`);
  }
  const got = answer.fields ?? {};
  return {
    message: answer.message.trim(),
    fields: Object.fromEntries(fields.map((f) => [f, typeof got[f] === "string" ? got[f] : ""])),
  };
}

/** The writer prompt for one email. */
export function notePrompt(config: Config, watch: Watch | undefined, category: string, description: string, state: State): string {
  const fields = Object.entries(watch?.fields ?? {});
  return fill(config.prompts.write, {
    watch: watch?.name ?? "default",
    category,
    description,
    hint: watch?.hint ?? "",
    fields: fields.length ? fields.map(([k, d]) => `${k}: ${d}`).join("; ") : "none",
    ...state,
  });
}
