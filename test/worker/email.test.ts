import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bodiesTo, configWith, deliver, eml, fakeAi, jevAnswer, ok, resetDb, stubFetch } from "./helpers";

const REJECTION = eml({ subject: "Your application", body: "We decided to move forward with other candidates." });
const NOISE = eml({ subject: "10 new jobs for you", body: "New roles matching your alert." });

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("classify and act", () => {
  it("forwards a confident category to its address and logs the row", async () => {
    stubFetch({ jev: jevAnswer("rejection", { rejection: 0.97, noise: 0.02, interview: 0.01 }) });
    const { message, row } = await deliver(REJECTION);

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner+rejected@example.com");
    expect(row).toMatchObject({
      to_addr: "jobs+acme@example.com",
      tag: "acme",
      from_addr: "jane@acme.com",
      subject: "Your application",
      message_id: "abc.123@mail.acme.com",
      watch: "jobs",
      category: "rejection",
      confidence: 0.97,
      action: "forwarded",
      forwarded_to: "owner+rejected@example.com",
      error: null,
      notified: null,
    });
    expect(JSON.parse(row.probs)).toEqual({ rejection: 0.97, noise: 0.02, interview: 0.01 });
    expect(row.cpu_ms).toBeGreaterThanOrEqual(0);
  });

  it("asks Jev one choice question over the watch's categories, with redacted state", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.9 }), telegram: ok, webhook: ok });
    await deliver(eml({ subject: "Call me", body: "Ring me on +90 532 123 4567 or mail jane@acme.com." }));

    const [jev] = await bodiesTo(fetch, "https://jev.test/");
    const request = fetch.mock.calls.find(([u]) => String(u instanceof Request ? u.url : u).startsWith("https://jev.test/"))!;
    expect(new Request(request[0], request[1]).headers.get("authorization")).toBe("Bearer jev-key");
    expect(jev.model).toBe("jev-test");
    expect(jev.state).toEqual({ from: "Jane Doe <[EMAIL]>", subject: "Call me", body: "Ring me on [PHONE] or mail [EMAIL]." });
    const question = jev.questions.category;
    expect(question.type).toBe("choice");
    expect(question.instructions).toContain('"jobs"');
    expect(Object.keys(question.criteria)).toEqual(["interview", "verification", "rejection", "noise", "ping"]);
    expect(question.criteria.interview).toBe("An invitation to interview or talk.");
  });

  it("applies the uncertain action below the category's min_confidence", async () => {
    stubFetch({ jev: jevAnswer("noise", { noise: 0.7, rejection: 0.3 }) });
    const { message, row } = await deliver(NOISE);

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner@example.com");
    expect(row).toMatchObject({ category: "uncertain", confidence: 0.7, action: "forwarded", forwarded_to: "owner@example.com" });
  });

  it("drops a confident drop category", async () => {
    stubFetch({ jev: jevAnswer("noise", { noise: 0.95 }) });
    const ai = fakeAi();
    const { message, row } = await deliver(NOISE, { ai });

    expect(message.forward).not.toHaveBeenCalled();
    expect(row).toMatchObject({ category: "noise", action: "dropped", forwarded_to: null });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("sends mail Jev cannot classify to on_error, never dropping it", async () => {
    stubFetch({ jev: () => new Response("quota exceeded", { status: 429 }), telegram: ok });
    const { message, row } = await deliver(NOISE);

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner@example.com");
    expect(row).toMatchObject({ watch: "jobs", category: "error", confidence: null, action: "forwarded" });
    expect(row.error).toMatch(/jev 429: quota exceeded/);
  });

  it("treats an answer outside the categories as a Jev failure", async () => {
    stubFetch({ jev: jevAnswer("offer", { offer: 1 }), telegram: ok });
    const { message, row } = await deliver(NOISE);

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner@example.com");
    expect(row.category).toBe("error");
    expect(row.error).toContain("offer");
  });

  it("treats a missing Jev key as a Jev failure", async () => {
    stubFetch({ telegram: ok });
    const { message, row } = await deliver(NOISE, { env: { TYPESAFE_API_KEY: undefined } });

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner@example.com");
    expect(row.error).toContain("TYPESAFE_API_KEY");
  });

  it("evaluates watches in order: the first match wins, by sender too", async () => {
    stubFetch({ jev: jevAnswer("important", { important: 1 }), webhook: ok });
    const vip = await deliver(eml({ from: "ceo@bigcorp.com", to: "hi@example.com", subject: "Hello", body: "Hi there" }), {
      to: "hi@example.com",
      from: "ceo@bigcorp.com",
    });
    expect(vip.row.watch).toBe("vip");

    stubFetch({ jev: jevAnswer("spam", { spam: 0.99 }) });
    const other = await deliver(eml({ to: "hi@example.com", subject: "Hello", body: "Buy now" }), { to: "hi@example.com" });
    expect(other.row).toMatchObject({ watch: "hi", category: "spam", action: "dropped" });
  });

  it("matches the recipient glob case-insensitively", async () => {
    stubFetch({ jev: jevAnswer("rejection", { rejection: 0.99 }) });
    const { row } = await deliver(REJECTION, { to: "Jobs+Globex@Example.com" });
    expect(row).toMatchObject({ watch: "jobs", tag: "Globex" });
  });

  it("matches by subject glob", async () => {
    const config = configWith((c) => c.watches.unshift({ ...c.watches[2], name: "invoices", match: { subject: ["*invoice*"] } }));
    stubFetch({ jev: jevAnswer("personal", { personal: 1 }), webhook: ok });
    const { row } = await deliver(eml({ to: "hi@example.com", subject: "Your Invoice 42", body: "Attached." }), { to: "hi@example.com", config });
    expect(row.watch).toBe("invoices");
  });

  it("gives unmatched mail the default action without calling Jev", async () => {
    const fetch = stubFetch({});
    const { message, row } = await deliver(eml({ to: "other@example.com", subject: "Hi", body: "Hello" }), { to: "other@example.com" });

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner@example.com");
    expect(row).toMatchObject({ watch: null, category: "default", action: "forwarded" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the inbox when a destination is not verified, and logs it", async () => {
    stubFetch({ jev: jevAnswer("rejection", { rejection: 0.99 }), telegram: ok });
    const { message, row } = await deliver(REJECTION, { failFor: ["owner+rejected@example.com"] });

    expect(message.forward.mock.calls).toEqual([["owner+rejected@example.com"], ["owner@example.com"]]);
    expect(row).toMatchObject({ category: "rejection", forwarded_to: "owner@example.com" });
    expect(row.error).toContain("not verified");
  });

  it("keeps the raw email in R2 when retention is on", async () => {
    stubFetch({ jev: jevAnswer("noise", { noise: 0.99 }) });
    const { row } = await deliver(NOISE);

    expect(row.r2_key).toBeTruthy();
    const object = await env.RAW.get(row.r2_key);
    expect(await object!.text()).toBe(NOISE);
  });

  it("keeps no raw email when retain_days is 0", async () => {
    stubFetch({ jev: jevAnswer("noise", { noise: 0.99 }) });
    const { row } = await deliver(NOISE, { config: configWith((c) => (c.retain_days = 0)) });
    expect(row.r2_key).toBeNull();
  });

  it("reads HTML mail as text, drops quoted replies and caps the body", async () => {
    const fetch = stubFetch({ jev: jevAnswer("noise", { noise: 0.99 }) });
    const html = `<html><style>p{color:red}</style><body><p>Hello&nbsp;there &amp; welcome</p><blockquote>old thread</blockquote><p>${"x".repeat(500)}</p></body></html>`;
    await deliver(eml({ subject: "Hi", body: html, html: true }), { config: configWith((c) => (c.redact.body_cap = 100)) });

    const [jev] = await bodiesTo(fetch, "https://jev.test/");
    expect(jev.state.body.startsWith("Hello there & welcome")).toBe(true);
    expect(jev.state.body).not.toContain("old thread");
    expect(jev.state.body).not.toContain("color");
    expect(jev.state.body.length).toBeLessThanOrEqual(100);
  });

  it("drops quoted lines from plain-text replies", async () => {
    const fetch = stubFetch({ jev: jevAnswer("noise", { noise: 0.99 }) });
    await deliver(eml({ subject: "Re: hi", body: "Sounds good.\n\nOn Mon, Jane wrote:\n> earlier text\n> more" }));
    const [jev] = await bodiesTo(fetch, "https://jev.test/");
    expect(jev.state.body).toBe("Sounds good.");
  });
});
