import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Config } from "../../src/config/schema";
import { createWorker } from "../../src/worker";

export const SECRETS = { TYPESAFE_API_KEY: "jev-key", TELEGRAM_BOT_TOKEN: "bot-token" };

/** A minimal RFC 822 message. */
export const eml = (o: { from?: string; to?: string; subject: string; body: string; html?: boolean; messageId?: string | null }) =>
  [
    `From: Jane Doe <${o.from ?? "jane@acme.com"}>`,
    `To: ${o.to ?? "jobs+acme@example.com"}`,
    `Subject: ${o.subject}`,
    ...(o.messageId === null ? [] : [`Message-ID: <${o.messageId ?? "abc.123@mail.acme.com"}>`]),
    `Content-Type: text/${o.html ? "html" : "plain"}; charset=utf-8`,
    "",
    o.body,
  ].join("\r\n");

/** The fixture config with a change applied. */
export function configWith(change: (c: Config) => void = () => {}): Config {
  const config = structuredClone(env.TEST_CONFIG);
  change(config);
  return config;
}

/** An inbound email as the runtime hands it to the email handler. */
export function fakeMessage(raw: string, o: { to?: string; from?: string; failFor?: string[] } = {}) {
  const forward = vi.fn(async (address: string) => {
    if (o.failFor?.includes(address)) throw new Error("destination address not verified");
  });
  return {
    from: o.from ?? "jane@acme.com",
    to: o.to ?? "jobs+acme@example.com",
    raw: new Response(raw).body!,
    rawSize: raw.length,
    headers: new Headers(),
    forward,
    setReject: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage & { forward: typeof forward };
}

type Handler = (req: Request) => Response | Promise<Response>;

/** Routes fetch calls by host. Unrouted calls throw, so tests see every external call. */
export function stubFetch(handlers: { jev?: Handler; telegram?: Handler; webhook?: Handler; openai?: Handler; access?: Handler }) {
  const routes: [string, Handler | undefined][] = [
    ["https://jev.test/", handlers.jev],
    ["https://api.telegram.org/", handlers.telegram],
    ["https://hook.test/", handlers.webhook],
    ["https://llm.test/", handlers.openai],
    ["https://team.test/", handlers.access],
  ];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const handler = routes.find(([prefix]) => req.url.startsWith(prefix))?.[1];
    if (!handler) throw new Error(`unexpected fetch ${req.url}`);
    return handler(req);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Bodies of the stubbed requests whose URL starts with `prefix`, parsed as JSON. */
export async function bodiesTo(fetch: ReturnType<typeof stubFetch>, prefix: string): Promise<any[]> {
  const out = [];
  for (const [input, init] of fetch.mock.calls) {
    const req = new Request(input, init);
    if (req.url.startsWith(prefix)) out.push(await req.json());
  }
  return out;
}

export const jevAnswer = (choice: string, probabilities: Record<string, number>) => () =>
  Response.json({ answers: { category: { choice, probabilities } } });

export const ok = () => Response.json({ ok: true });

/** A Workers AI stub whose writer answers are `answer` (an object becomes the JSON response). */
export function fakeAi(answer: unknown | Error = { message: "Acme wants a 30 minute call next week.", fields: { company: "Acme", role: "Backend Engineer" } }) {
  const run = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { response: answer };
  });
  return { run } as unknown as Ai & { run: typeof run };
}

export interface Delivery {
  config?: Config;
  to?: string;
  from?: string;
  failFor?: string[];
  ai?: Ai;
  env?: Record<string, unknown>;
}

/** Delivers one email through the email handler and waits for its background work. */
export async function deliver(raw: string, o: Delivery = {}) {
  const message = fakeMessage(raw, o);
  const ctx = createExecutionContext();
  const worker = createWorker(o.config ?? configWith());
  await worker.email!(message, { ...env, ...SECRETS, AI: o.ai ?? fakeAi(), ...o.env } as Env, ctx);
  await waitOnExecutionContext(ctx);
  const row = await env.DB.prepare("SELECT * FROM mail ORDER BY id DESC LIMIT 1").first<Record<string, any>>();
  return { message, row: row! };
}

/** Runs the scheduled handler for one cron. */
export async function schedule(cron: string, o: { config?: Config; ai?: Ai; env?: Record<string, unknown>; at?: Date } = {}) {
  const ctx = createExecutionContext();
  const controller = createScheduledController({ cron, scheduledTime: (o.at ?? new Date()).getTime() });
  await createWorker(o.config ?? configWith()).scheduled!(controller, { ...env, ...SECRETS, AI: o.ai ?? fakeAi(), ...o.env } as Env, ctx);
  await waitOnExecutionContext(ctx);
}

export const alerts = () => env.DB.prepare("SELECT * FROM alerts ORDER BY id").all<Record<string, any>>().then((r) => r.results);
export const runs = () => env.DB.prepare("SELECT * FROM runs ORDER BY id").all<Record<string, any>>().then((r) => r.results);

export async function resetDb() {
  await env.DB.batch(["mail", "alerts", "runs"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}
