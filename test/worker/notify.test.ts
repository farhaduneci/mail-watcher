import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bodiesTo, configWith, deliver, eml, fakeAi, jevAnswer, ok, resetDb, stubFetch } from "./helpers";

const INTERVIEW = eml({
  subject: "Backend Engineer - next steps",
  body: "Thanks for applying! Could you pick a slot for a call? Or ring me on +90 532 123 4567.",
});
const GMAIL = "https://mail.google.com/mail/?authuser=owner%40example.com#search/rfc822msgid%3Aabc.123%40mail.acme.com";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("notes", () => {
  it("writes a note from the redacted email and sends it to every channel of the category", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.95 }), telegram: ok, webhook: ok });
    const ai = fakeAi();
    const { message, row } = await deliver(INTERVIEW, { ai });

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner+attention@example.com");
    const [model, input] = ai.run.mock.calls[0] as unknown as [string, { messages: { content: string }[] }];
    expect(model).toBe("test-writer");
    const prompt = input.messages[0].content;
    expect(prompt).toContain("Or ring me on [PHONE].");
    expect(prompt).not.toContain("532");
    expect(prompt).toContain("Name the company and the next step.");
    expect(prompt).toContain("company: The hiring company");

    const [telegram] = await bodiesTo(fetch, "https://api.telegram.org/botbot-token/sendMessage");
    expect(telegram).toMatchObject({ chat_id: "42", parse_mode: "HTML" });
    expect(telegram.text).toBe(
      [
        "Acme wants a 30 minute call next week.",
        `<a href="${GMAIL}">Backend Engineer - next steps</a>`,
        "PHONE: <code>+90 532 123 4567</code>",
        "#jobs #interview",
      ].join("\n\n"),
    );

    const [hook] = await bodiesTo(fetch, "https://hook.test/in");
    expect(hook).toEqual({
      text: "Acme wants a 30 minute call next week.",
      link: { url: GMAIL, label: "Backend Engineer - next steps" },
      reveals: { PHONE: ["+90 532 123 4567"] },
      tags: ["jobs", "interview"],
      watch: "jobs",
      category: "interview",
      subject: "Backend Engineer - next steps",
    });

    expect(row).toMatchObject({ action: "forwarded,notified", summary: "Acme wants a 30 minute call next week.", error: null });
    expect(JSON.parse(row.fields)).toEqual({ company: "Acme", role: "Backend Engineer" });
    expect(JSON.parse(row.notified)).toEqual({ phone: "ok", hook: "ok" });
  });

  it("never stores a revealed value in the ledger", async () => {
    stubFetch({ jev: jevAnswer("interview", { interview: 0.95 }), telegram: ok, webhook: ok });
    const ai = fakeAi({ message: "Call [PHONE] back.", fields: { company: "Acme", role: "" } });
    const { row } = await deliver(INTERVIEW, { ai, config: configWith((c) => (c.retain_days = 0)) });
    expect(JSON.stringify(row)).not.toMatch(/532/);
  });

  it("falls back to the subject, link and tags when the writer fails", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.95 }), telegram: ok, webhook: ok });
    const { row } = await deliver(INTERVIEW, { ai: fakeAi(new Error("model overloaded")) });

    const [hook] = await bodiesTo(fetch, "https://hook.test/in");
    expect(hook).toMatchObject({ text: "Backend Engineer - next steps", link: { url: GMAIL }, tags: ["jobs", "interview"] });
    expect(row.error).toContain("writer: model overloaded");
    expect(row.summary).toBeNull();
    expect(JSON.parse(row.notified)).toEqual({ phone: "ok", hook: "ok" });
  });

  it("falls back when the writer answers without a message", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.95 }), telegram: ok, webhook: ok });
    await deliver(INTERVIEW, { ai: fakeAi("not json at all") });
    const [hook] = await bodiesTo(fetch, "https://hook.test/in");
    expect(hook.text).toBe("Backend Engineer - next steps");
  });

  it("links to a subject search when the email has no Message-ID", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.95 }), telegram: ok, webhook: ok });
    await deliver(eml({ subject: "Chat & coffee?", body: "Free Friday?", messageId: null }));
    const [hook] = await bodiesTo(fetch, "https://hook.test/in");
    expect(hook.link).toEqual({
      url: "https://mail.google.com/mail/?authuser=owner%40example.com#search/subject%3AChat%20%26%20coffee%3F",
      label: "Chat & coffee?",
    });
  });

  it("uses the configured mailbox link template", async () => {
    const config = configWith((c) => (c.mailbox.link = "https://mail.test/open?id={message_id}"));
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.95 }), telegram: ok, webhook: ok });
    await deliver(INTERVIEW, { config });
    const [hook] = await bodiesTo(fetch, "https://hook.test/in");
    expect(hook.link.url).toBe("https://mail.test/open?id=abc.123%40mail.acme.com");
  });

  it("notifies without forwarding for a notify-only category", async () => {
    const fetch = stubFetch({ jev: jevAnswer("ping", { ping: 0.6 }), telegram: ok });
    const { message, row } = await deliver(INTERVIEW);

    expect(message.forward).not.toHaveBeenCalled();
    expect(row).toMatchObject({ category: "ping", action: "notified", forwarded_to: null });
    expect(await bodiesTo(fetch, "https://api.telegram.org/")).toHaveLength(1);
  });

  it("records a notify-only email whose every channel failed as dropped", async () => {
    stubFetch({ jev: jevAnswer("ping", { ping: 0.6 }), telegram: () => new Response("down", { status: 502 }) });
    const { row } = await deliver(INTERVIEW);
    expect(row).toMatchObject({ action: "dropped", forwarded_to: null });
    expect(row.error).toContain("telegram 502");
  });

  it("costs only the Jev call for mail that does not notify", async () => {
    const fetch = stubFetch({ jev: jevAnswer("verification", { verification: 0.99 }) });
    const ai = fakeAi();
    const { row } = await deliver(eml({ subject: "Verify", body: "Your code is 123456" }), { ai });

    expect(ai.run).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ category: "verification", summary: null, fields: null, notified: null });
  });

  it("extracts fields from every email of an extract: always watch", async () => {
    const fetch = stubFetch({ jev: jevAnswer("important", { important: 1 }) });
    const ai = fakeAi({ message: "unused", fields: { topic: "Partnership" } });
    const { row } = await deliver(eml({ from: "ceo@bigcorp.com", to: "hi@example.com", subject: "Partnership", body: "Shall we?" }), {
      to: "hi@example.com",
      from: "ceo@bigcorp.com",
      ai,
    });

    expect(ai.run).toHaveBeenCalledOnce();
    expect(JSON.parse(row.fields)).toEqual({ topic: "Partnership" });
    expect(row.notified).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("records a failed channel and still delivers to the others", async () => {
    stubFetch({ jev: jevAnswer("interview", { interview: 0.95 }), telegram: () => new Response("chat not found", { status: 400 }), webhook: ok });
    const { row } = await deliver(INTERVIEW);

    const notified = JSON.parse(row.notified);
    expect(notified.hook).toBe("ok");
    expect(notified.phone).toMatch(/telegram 400: chat not found/);
    expect(row.action).toBe("forwarded,notified");
    expect(row.error).toContain("phone");
  });

  it("writes with an OpenAI-compatible endpoint", async () => {
    const config = configWith((c) => {
      c.models.write = { provider: "openai-compatible", base_url: "https://llm.test/v1", model: "gpt-test", key_secret: "LLM_KEY", max_tokens: 300 };
    });
    const fetch = stubFetch({
      jev: jevAnswer("interview", { interview: 0.95 }),
      telegram: ok,
      webhook: ok,
      openai: () => Response.json({ choices: [{ message: { content: JSON.stringify({ message: "From the endpoint.", fields: { company: "Acme", role: "" } }) } }] }),
    });
    const { row } = await deliver(INTERVIEW, { config, env: { LLM_KEY: "llm-key" } });

    const call = fetch.mock.calls.map(([i, init]) => new Request(i, init)).find((r) => r.url === "https://llm.test/v1/chat/completions")!;
    expect(call.headers.get("authorization")).toBe("Bearer llm-key");
    const body = await call.json<any>();
    expect(body).toMatchObject({ model: "gpt-test", max_tokens: 300, response_format: { type: "json_schema" } });
    expect(row.summary).toBe("From the endpoint.");
  });

  it("notifies from on_error when Jev fails, if the watch asks for it", async () => {
    const fetch = stubFetch({ jev: () => new Response("down", { status: 503 }), telegram: ok, webhook: ok });
    const { message } = await deliver(eml({ to: "hi@example.com", subject: "Hello", body: "Hi" }), { to: "hi@example.com" });

    expect(message.forward).toHaveBeenCalledExactlyOnceWith("owner@example.com");
    const [hook] = await bodiesTo(fetch, "https://hook.test/in");
    expect(hook).toMatchObject({ watch: "hi", category: "error", tags: ["hi", "error"] });
  });

  it("escapes HTML in Telegram notes", async () => {
    const fetch = stubFetch({ jev: jevAnswer("interview", { interview: 0.95 }), telegram: ok, webhook: ok });
    await deliver(INTERVIEW, { ai: fakeAi({ message: "Use <b>bold</b> & more", fields: {} }) });
    const [telegram] = await bodiesTo(fetch, "https://api.telegram.org/");
    expect(telegram.text.split("\n\n")[0]).toBe("Use &lt;b&gt;bold&lt;/b&gt; &amp; more");
  });
});
