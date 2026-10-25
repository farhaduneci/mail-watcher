import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alerts, bodiesTo, configWith, deliver, eml, fakeAi, jevAnswer, ok, resetDb, runs, schedule, stubFetch } from "./helpers";

const NOISE = eml({ subject: "10 new jobs for you", body: "New roles matching your alert." });
const INTERVIEW = eml({ subject: "Interview", body: "Can we talk tomorrow?" });
const SELFTEST = "0 7 * * *";

const opsMessages = async (fetch: ReturnType<typeof stubFetch>) =>
  (await bodiesTo(fetch, "https://api.telegram.org/")).filter((b) => b.chat_id === "7");
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("alerts", () => {
  it("alerts the alert channels when Jev fails, with the configured message", async () => {
    const fetch = stubFetch({ jev: () => new Response("quota", { status: 429 }), telegram: ok });
    await deliver(NOISE);

    const [alert] = await opsMessages(fetch);
    expect(alert.text).toMatch(/^Jev failed, so mail went to the on_error action: jobs: jev 429: quota/);
    expect(alert.text).toContain("#mailsentry #alert #jev");
    expect(await alerts()).toMatchObject([{ kind: "jev", sent: "sent" }]);
  });

  it("throttles to one alert per kind per window", async () => {
    const fetch = stubFetch({ jev: () => new Response("quota", { status: 429 }), telegram: ok });
    await deliver(NOISE);
    await deliver(NOISE);

    expect(await opsMessages(fetch)).toHaveLength(1);
    expect((await alerts()).map((a) => a.sent)).toEqual(["sent", "throttled"]);
  });

  it("alerts again once the window has passed", async () => {
    const fetch = stubFetch({ jev: () => new Response("quota", { status: 429 }), telegram: ok });
    await deliver(NOISE);
    await env.DB.prepare("UPDATE alerts SET at = ?").bind(hoursAgo(2)).run();
    await deliver(NOISE);

    expect(await opsMessages(fetch)).toHaveLength(2);
  });

  it("throttles each kind on its own", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok, webhook: ok });
    await deliver(INTERVIEW, { ai: fakeAi(new Error("writer down")) });
    stubFetch({ jev: () => new Response("x", { status: 500 }), telegram: ok });
    await deliver(NOISE);

    expect((await alerts()).map((a) => [a.kind, a.sent])).toEqual([
      ["writer", "sent"],
      ["jev", "sent"],
    ]);
    expect((await opsMessages(fetch))[0].text).toContain("writer down");
  });

  it("alerts when a forward fails", async () => {
    const fetch = stubFetch({ jev: jevAnswer("rejection", { rejection: 0.99 }), telegram: ok });
    await deliver(eml({ subject: "No", body: "Sorry." }), { failFor: ["owner+rejected@example.com"] });

    const [alert] = await opsMessages(fetch);
    expect(alert.text).toMatch(/^A forward failed: owner\+rejected@example.com: destination address not verified/);
  });

  it("alerts when a channel fails", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok, webhook: () => new Response("gone", { status: 410 }) });
    await deliver(INTERVIEW);

    const [alert] = await opsMessages(fetch);
    expect(alert.text).toMatch(/^A channel failed to deliver a note: hook: error: webhook 410: gone/);
  });

  it("records an alert channel that fails, so the dashboard can show it", async () => {
    stubFetch({ jev: () => new Response("x", { status: 500 }), telegram: () => new Response("bot blocked", { status: 403 }) });
    await deliver(NOISE);

    const [row] = await alerts();
    expect(row.kind).toBe("jev");
    expect(row.sent).toMatch(/^failed: ops: error: telegram 403: bot blocked/);
  });

  it("keeps a failed alert from throttling the next one", async () => {
    stubFetch({ jev: () => new Response("x", { status: 500 }), telegram: () => new Response("down", { status: 502 }) });
    await deliver(NOISE);
    const fetch = stubFetch({ jev: () => new Response("x", { status: 500 }), telegram: ok });
    await deliver(NOISE);

    expect(await opsMessages(fetch)).toHaveLength(1);
  });
});

describe("self-test", () => {
  it("runs the sample through redact, Jev and the writer, renders every channel without sending, and records a pass", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }) });
    const ai = fakeAi();
    await schedule(SELFTEST, { ai });

    const [jev] = await bodiesTo(fetch, "https://jev.test/");
    expect(jev.state.body).toBe("Hi, we would like to invite you to an interview. Call [PHONE].");
    expect(ai.run).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(await runs()).toMatchObject([{ job: "selftest", ok: 1 }]);
    expect(await alerts()).toEqual([]);
  });

  it("fails and alerts when Jev fails", async () => {
    const fetch = stubFetch({ jev: () => new Response("bad key", { status: 401 }), telegram: ok });
    await schedule(SELFTEST);

    const [run] = await runs();
    expect(run).toMatchObject({ job: "selftest", ok: 0 });
    expect(run.detail).toContain("jev 401");
    const [alert] = await opsMessages(fetch);
    expect(alert.text).toMatch(/^The self-test failed: .*jev 401/);
  });

  it("fails when Jev picks a different category than expected", async () => {
    stubFetch({ jev: jevAnswer("noise", { noise: 0.9 }), telegram: ok });
    await schedule(SELFTEST);
    expect((await runs())[0].detail).toContain('expected "interview", got "noise"');
  });

  it("fails when the writer fails", async () => {
    stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok });
    await schedule(SELFTEST, { ai: fakeAi(new Error("no such model")) });
    expect((await runs())[0]).toMatchObject({ ok: 0, detail: expect.stringContaining("no such model") });
  });

  it("fails when a channel cannot render, e.g. a missing secret", async () => {
    stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok });
    await schedule(SELFTEST, { env: { TELEGRAM_BOT_TOKEN: undefined } });

    expect((await runs())[0].detail).toContain("TELEGRAM_BOT_TOKEN");
    expect((await alerts())[0].sent).toMatch(/^failed:/);
  });

  it("alerts when a watch with silence_hours has gone quiet", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok });
    await env.DB.prepare("INSERT INTO mail (at, watch, category) VALUES (?, 'jobs', 'noise')").bind(hoursAgo(72)).run();
    await schedule(SELFTEST);

    const silence = (await opsMessages(fetch)).find((m) => m.text.startsWith("A watch has gone quiet"));
    expect(silence?.text).toContain("jobs");
    expect(await alerts()).toMatchObject([{ kind: "silence", sent: "sent" }]);
  });

  it("stays quiet when the watch had mail recently", async () => {
    stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }) });
    await env.DB.prepare("INSERT INTO mail (at, watch, category) VALUES (?, 'jobs', 'noise')").bind(hoursAgo(72)).run();
    await env.DB.prepare("INSERT INTO mail (at, watch, category) VALUES (?, 'jobs', 'noise')").bind(hoursAgo(5)).run();
    await schedule(SELFTEST);
    expect(await alerts()).toEqual([]);
  });

  it("deletes raw emails older than retain_days", async () => {
    stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }) });
    await env.RAW.put("raw/old.eml", "old");
    await env.RAW.put("raw/new.eml", "new");
    await env.DB.prepare("INSERT INTO mail (at, watch, category, r2_key) VALUES (?, 'hi', 'spam', 'raw/old.eml'), (?, 'hi', 'spam', 'raw/new.eml')")
      .bind(hoursAgo(24 * 31), hoursAgo(1))
      .run();
    await schedule(SELFTEST);

    expect(await env.RAW.get("raw/old.eml")).toBeNull();
    expect(await env.RAW.get("raw/new.eml")).not.toBeNull();
    const { results } = await env.DB.prepare("SELECT r2_key FROM mail ORDER BY at").all();
    expect(results).toEqual([{ r2_key: null }, { r2_key: "raw/new.eml" }]);
  });

  it("ignores a cron it has no job for", async () => {
    const fetch = stubFetch({});
    await schedule("*/5 * * * *", { config: configWith() });
    expect(fetch).not.toHaveBeenCalled();
    expect(await runs()).toEqual([]);
  });
});

describe("more failures that alert", () => {
  it("still forwards mail that cannot be read, and alerts", async () => {
    const fetch = stubFetch({ telegram: ok });
    const { message, row } = await deliver(NOISE, { brokenRaw: true });

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner@example.com");
    expect(row).toMatchObject({ watch: "jobs", category: "error", action: "forwarded" });
    expect(row.error).toContain("stream reset");
    const [alert] = await opsMessages(fetch);
    expect(alert.text).toMatch(/^An email could not be read; its on_error \(or default\) action applied: jobs\+acme@example.com: .*stream reset/);
    expect(await alerts()).toMatchObject([{ kind: "parse", sent: "sent" }]);
  });

  it("alerts when the raw email cannot be stored", async () => {
    const fetch = stubFetch({ jev: jevAnswer("noise", { noise: 0.99 }), telegram: ok });
    const RAW = { put: async () => Promise.reject(new Error("bucket gone")) };
    const { row } = await deliver(NOISE, { env: { RAW } });

    expect(row).toMatchObject({ category: "noise", r2_key: null });
    expect(row.error).toContain("bucket gone");
    const [alert] = await opsMessages(fetch);
    expect(alert.text).toMatch(/^The raw email could not be stored: .*bucket gone/);
  });

  it("raises a config alert, not a Jev alert, when the Jev key secret is missing", async () => {
    stubFetch({ telegram: ok });
    const { message } = await deliver(NOISE, { env: { TYPESAFE_API_KEY: undefined } });

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner@example.com");
    expect(await alerts()).toMatchObject([{ kind: "config", detail: expect.stringContaining("TYPESAFE_API_KEY") }]);
  });

  it("raises a config alert when a channel's secret is missing", async () => {
    stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok, webhook: ok });
    await deliver(INTERVIEW, { env: { TELEGRAM_BOT_TOKEN: undefined } });

    const [row] = await alerts();
    expect(row).toMatchObject({ kind: "config", detail: expect.stringContaining("TELEGRAM_BOT_TOKEN") });
    // The alert channel needs the same secret, so its delivery failure is on record.
    expect(row.sent).toMatch(/^failed:/);
  });

  it("checks secrets and bindings on the self-test cron", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok });
    await schedule(SELFTEST, { env: { RAW: undefined, EXTRA_UNUSED: "x" } });

    const config = (await alerts()).find((a) => a.kind === "config");
    expect(config?.detail).toContain("retain_days is 30 but the RAW R2 binding is missing");
    expect((await opsMessages(fetch)).some((m) => m.text.startsWith("The config is broken:"))).toBe(true);
  });

  it("lists every missing secret on the self-test cron", async () => {
    stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok });
    await schedule(SELFTEST, { config: configWith((c) => (c.channels.hook.token_secret = "HOOK_TOKEN")) });

    const config = (await alerts()).find((a) => a.kind === "config");
    expect(config?.detail).toContain("secret HOOK_TOKEN is not set");
  });
});
