// Jev, TypeSafe's judgment model (https://typesafe.ai): one choice question, a probability per
// option. The only classifier; failures surface instead of falling back.
import { need, type Secrets } from "./channels/types";
import type { Config, Watch } from "./config/schema";
import { fill } from "./template";

export interface Verdict {
  choice: string;
  probabilities: Record<string, number>;
}

export interface State {
  from: string;
  subject: string;
  body: string;
}

export async function classify(config: Config, secrets: Secrets, watch: Watch, state: State): Promise<Verdict> {
  const { url, model, key_secret } = config.models.classify;
  const key = need(secrets, key_secret);
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      state,
      questions: {
        category: {
          type: "choice",
          instructions: fill(config.prompts.classify, { watch: watch.name, hint: watch.hint }).trim(),
          criteria: Object.fromEntries(Object.entries(watch.categories).map(([name, c]) => [name, c.description])),
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const answer = ((await res.json()) as { answers?: { category?: Partial<Verdict> } }).answers?.category;
  if (!answer?.choice || !Object.hasOwn(watch.categories, answer.choice)) {
    throw new Error(`jev answered outside the categories: ${JSON.stringify(answer).slice(0, 300)}`);
  }
  return { choice: answer.choice, probabilities: answer.probabilities ?? { [answer.choice]: 1 } };
}
