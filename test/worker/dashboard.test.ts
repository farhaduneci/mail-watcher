import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config/schema";
import { createWorker } from "../../src/worker";
import { configWith, resetDb, SECRETS, stubFetch } from "./helpers";

async function get(path: string, o: { config?: Config; headers?: Record<string, string>; method?: string } = {}) {
  const ctx = createExecutionContext();
  const req = new Request(`https://watch.example.com${path}`, { method: o.method ?? "GET", headers: o.headers });
  const res = await createWorker(o.config ?? configWith()).fetch!(req as any, { ...env, ...SECRETS } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seed() {
  const rows = [
    ["2026-10-10T09:00:00.000Z", "jobs+acme@example.com", "acme", "jane@acme.com", "Interview <script>x</script>", "abc@acme.com", "jobs", "interview", 0.95, "forwarded,notified", "Acme wants a call.", "raw/a.eml"],
    ["2026-10-10T10:00:00.000Z", "jobs+globex@example.com", "globex", "hr@globex.com", "Your application", "def@globex.com", "jobs", "rejection", 0.97, "forwarded", null, null],
    ["2026-10-11T10:00:00.000Z", "hi@example.com", "", "spam@spam.test", "Buy now", null, "hi", "spam", 0.99, "dropped", null, null],
  ];
  for (const r of rows) {
    await env.DB.prepare(
      "INSERT INTO mail (at, to_addr, tag, from_addr, subject, message_id, watch, category, confidence, action, summary, r2_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(...r)
      .run();
  }
  await env.RAW.put("raw/a.eml", "From: jane@acme.com\r\n\r\nhello");
  await env.DB.prepare("INSERT INTO alerts (at, kind, detail, sent) VALUES ('2026-10-11T11:00:00.000Z', 'jev', 'jev 429', 'failed: ops: error: telegram 403')").run();
  await env.DB.prepare("INSERT INTO runs (at, job, ok, detail) VALUES ('2026-10-11T07:00:00.000Z', 'selftest', 1, 'jobs: interview (0.9)')").run();
}

const idOf = async (subject: string) =>
  (await env.DB.prepare("SELECT id FROM mail WHERE subject = ?").bind(subject).first<{ id: number }>())!.id;

beforeEach(async () => {
  await resetDb();
  await seed();
});
afterEach(() => vi.unstubAllGlobals());

describe("dashboard", () => {
  it("lists the ledger with mailbox links and raw downloads, escaping content", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    expect(html).toContain("Interview &lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x");
    expect(html).toContain('href="https://mail.google.com/mail/?authuser=owner%40example.com#search/rfc822msgid%3Aabc%40acme.com"');
    expect(html).toContain(`href="/raw/${await idOf("Interview <script>x</script>")}"`);
    expect(html).toContain("Your application");
    expect(html).toContain("Buy now");
  });

  it("filters the ledger by watch, category and action", async () => {
    const html = await (await get("/?watch=jobs&action=notified")).text();
    expect(html).toContain("Acme wants a call.");
    expect(html).not.toContain("Your application");
    expect(html).not.toContain("Buy now");

    const byCategory = await (await get("/?category=spam")).text();
    expect(byCategory).toContain("Buy now");
    expect(byCategory).not.toContain("Your application");
  });

  it("shows stats per watch and category", async () => {
    const html = await (await get("/stats")).text();
    expect(html).toMatch(/<td>jobs<\/td><td>interview<\/td><td>1<\/td>/);
    expect(html).toMatch(/<td>hi<\/td><td>spam<\/td><td>1<\/td>/);
    expect(html).toMatch(/<td>2026-10-10<\/td><td>2<\/td>/);
  });

  it("shows alerts, including failed alert deliveries, and self-test runs", async () => {
    const html = await (await get("/health")).text();
    expect(html).toContain("failed: ops: error: telegram 403");
    expect(html).toContain("jobs: interview (0.9)");
  });

  it("shows the effective config with secret names, never values", async () => {
    const html = await (await get("/config", { config: configWith((c) => (c.models.classify.key_secret = "MISSING_KEY")) })).text();
    expect(html).toContain("TELEGRAM_BOT_TOKEN (set)");
    expect(html).toContain("MISSING_KEY (missing)");
    expect(html).not.toContain("bot-token");
    expect(html).toContain("owner+attention@example.com");
  });

  it("downloads a retained raw email", async () => {
    const res = await get(`/raw/${await idOf("Interview <script>x</script>")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("message/rfc822");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="mail-\d+\.eml"/);
    expect(await res.text()).toContain("hello");
    expect((await get(`/raw/${await idOf("Buy now")}`)).status).toBe(404);
  });

  it("is read-only and 404s unknown paths", async () => {
    expect((await get("/", { method: "POST" })).status).toBe(405);
    expect((await get("/nope")).status).toBe(404);
  });

  it("is off when neither Access nor unprotected is configured", async () => {
    const res = await get("/", { config: configWith((c) => (c.dashboard = { unprotected: false })) });
    expect(res.status).toBe(404);
  });
});

describe("dashboard behind Cloudflare Access", () => {
  const AUD = "aud-123";
  const ACCESS = configWith((c) => (c.dashboard = { unprotected: false, access: { team_domain: "team.test", aud: AUD } }));
  let keys: CryptoKeyPair;

  const b64 = (data: ArrayBuffer | string) =>
    btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  async function jwt(claims: Record<string, unknown>, kid = "k1") {
    const head = b64(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const body = b64(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64(sig)}`;
  }
  const valid = () => ({ aud: [AUD], iss: "https://team.test", exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" });

  beforeEach(async () => {
    keys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    stubFetch({ access: () => Response.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] }) });
  });

  it("rejects a request without the Access token", async () => {
    expect((await get("/", { config: ACCESS })).status).toBe(403);
  });

  it("serves a request with a valid Access token", async () => {
    const res = await get("/", { config: ACCESS, headers: { "cf-access-jwt-assertion": await jwt(valid()) } });
    expect(res.status).toBe(200);
  });

  it.each([
    ["the wrong audience", { aud: ["other"] }],
    ["the wrong issuer", { iss: "https://evil.test" }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 10 }],
  ])("rejects %s", async (_name, over) => {
    const res = await get("/", { config: ACCESS, headers: { "cf-access-jwt-assertion": await jwt({ ...valid(), ...over }) } });
    expect(res.status).toBe(403);
  });

  it("rejects a token signed by an unknown key", async () => {
    const res = await get("/", { config: ACCESS, headers: { "cf-access-jwt-assertion": await jwt(valid(), "other-kid") } });
    expect(res.status).toBe(403);
  });

  it("rejects a tampered token", async () => {
    const token = await jwt(valid());
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64(JSON.stringify({ ...valid(), email: "evil@example.com" }))}.${s}`;
    expect((await get("/", { config: ACCESS, headers: { "cf-access-jwt-assertion": forged } })).status).toBe(403);
  });
});
