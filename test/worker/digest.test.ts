import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alerts, bodiesTo, fakeAi, ok, resetDb, runs, schedule, stubFetch } from "./helpers";

const DIGEST = "0 8 * * MON";
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

async function seed() {
  const rows: [number, string | null, string, string, string][] = [
    [1, "jobs", "interview", "Interview at Acme, call +90 532 123 4567", "forwarded,notified"],
    [2, "jobs", "interview", "Next steps with Globex", "forwarded,notified"],
    [3, "jobs", "noise", "10 new jobs", "dropped"],
    [3, "jobs", "uncertain", "Something odd", "forwarded"],
    [4, null, "default", "Hello", "forwarded"],
    [9, "jobs", "offer", "Old offer", "forwarded,notified"],
  ];
  for (const [d, watch, category, subject, action] of rows) {
    await env.DB.prepare("INSERT INTO mail (at, watch, category, subject, action) VALUES (?, ?, ?, ?, ?)").bind(daysAgo(d), watch, category, subject, action).run();
  }
}

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

describe("digest", () => {
  it("has the writer summarize the week's counts and notable subjects, redacted, and sends it", async () => {
    await seed();
    const fetch = stubFetch({ telegram: ok });
    const ai = fakeAi({ message: "Two interviews this week.", fields: {} });
    await schedule(DIGEST, { ai });

    const prompt = (ai.run.mock.calls[0] as any)[1].messages[0].content as string;
    expect(prompt).toContain("last 7 days");
    expect(prompt).toContain(JSON.stringify({ jobs: { interview: 2, noise: 1, uncertain: 1 }, default: { default: 1 } }));
    expect(prompt).toContain("- jobs/interview: Interview at Acme, call [PHONE]");
    expect(prompt).toContain("- jobs/uncertain: Something odd");
    expect(prompt).not.toContain("10 new jobs");
    expect(prompt).not.toContain("Old offer");

    const [message] = await bodiesTo(fetch, "https://api.telegram.org/");
    expect(message.chat_id).toBe("42");
    expect(message.text).toBe("Two interviews this week.\n\n#mail_watcher #digest");
    expect(await runs()).toMatchObject([{ job: "digest", ok: 1 }]);
  });

  it("sends plain counts and alerts when the writer fails", async () => {
    await seed();
    const fetch = stubFetch({ telegram: ok });
    await schedule(DIGEST, { ai: fakeAi(new Error("writer down")) });

    const digest = (await bodiesTo(fetch, "https://api.telegram.org/")).find((m) => m.chat_id === "42");
    expect(digest.text).toContain("jobs: interview 2, noise 1, uncertain 1");
    expect(await runs()).toMatchObject([{ job: "digest", ok: 0 }]);
    expect(await alerts()).toMatchObject([{ kind: "writer" }]);
  });

  it("records a failed delivery and alerts", async () => {
    stubFetch({ telegram: (req) => (req.url.includes("bot-token") ? new Response("nope", { status: 500 }) : ok()) });
    await schedule(DIGEST);
    expect((await runs())[0]).toMatchObject({ ok: 0, detail: expect.stringContaining("telegram 500") });
    expect((await alerts())[0].kind).toBe("channel");
  });
});
