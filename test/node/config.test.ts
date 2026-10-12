import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ConfigError, loadConfig } from "../../src/config/load";

const FIXTURE = readFileSync(join(import.meta.dirname, "../fixtures/config.yaml"), "utf8");
const EXAMPLE = readFileSync(join(import.meta.dirname, "../../mail-watcher.example.yaml"), "utf8");
const CRONS = ["0 7 * * *", "0 8 * * MON"];

/** The fixture with one change applied to its parsed form. */
function variant(change: (doc: any) => void): string {
  const doc = parse(FIXTURE);
  change(doc);
  return stringify(doc);
}

function issuesOf(yaml: string, crons = CRONS): string[] {
  try {
    loadConfig(yaml, { crons });
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error("expected the config to be rejected");
}

describe("loadConfig", () => {
  it("bundles a good config with defaults applied", () => {
    const config = loadConfig(FIXTURE, { crons: CRONS });
    const jobs = config.watches[0];

    expect(jobs.categories.noise.min_confidence).toBe(0.8);
    expect(jobs.categories.ping.min_confidence).toBe(0.5);
    expect(jobs.categories.interview.min_confidence).toBe(0);
    expect(jobs.uncertain).toEqual({ forward: "inbox", notify: [] });
    expect(jobs.on_error).toEqual({ forward: "inbox", notify: [] });
    expect(jobs.extract).toBe("notify");
    expect(config.alerts.throttle_minutes).toBe(60);
    expect(config.redact.phone_regions).toEqual(expect.arrayContaining(["IR", "TR", "DE", "GB", "US", "NL"]));
    expect(config.redact.detectors).toMatchObject({ link: true, phone: true, secret: true });
    expect(config.prompts.write).toContain("{body}");
    expect(config.alerts.messages.jev).toContain("{detail}");
    expect(config.mailbox.link).toContain("{message_id}");
  });

  it("accepts the shipped example config", () => {
    expect(() => loadConfig(EXAMPLE, { crons: CRONS })).not.toThrow();
  });

  it("rejects malformed YAML with the line", () => {
    expect(issuesOf("watches: [\n  - name: x\n bad")[0]).toMatch(/YAML.*line/i);
  });

  it("rejects a reference to a channel that does not exist", () => {
    const yaml = variant((d) => (d.watches[0].categories.interview.notify = ["phone", "pager"]));
    expect(issuesOf(yaml)).toContain('watches[0].categories.interview.notify: unknown channel "pager"');
  });

  it("rejects alert and digest channels that do not exist", () => {
    const yaml = variant((d) => {
      d.alerts.channels = ["nope"];
      d.schedules.digest_channels = ["gone"];
    });
    expect(issuesOf(yaml)).toEqual(
      expect.arrayContaining(['alerts.channels: unknown channel "nope"', 'schedules.digest_channels: unknown channel "gone"']),
    );
  });

  it("rejects an on_error action that drops mail", () => {
    const yaml = variant((d) => (d.watches[2].on_error = { notify: ["hook"] }));
    expect(issuesOf(yaml)).toContain("watches[2].on_error: must forward; on_error can never drop mail");
  });

  it("checks each channel's settings with that channel's own schema", () => {
    const yaml = variant((d) => delete d.channels.phone.chat_id);
    expect(issuesOf(yaml).join("\n")).toMatch(/^channels\.phone\.chat_id: /m);
  });

  it("rejects an unknown channel type", () => {
    const yaml = variant((d) => (d.channels.phone.type = "pigeon"));
    expect(issuesOf(yaml).join("\n")).toMatch(/channels\.phone\.type: .*telegram.*webhook/);
  });

  it("rejects a schedule with no matching cron in wrangler.jsonc", () => {
    expect(issuesOf(FIXTURE, ["0 7 * * *"])).toContain('schedules.digest: cron "0 8 * * MON" is not in wrangler.jsonc triggers.crons');
  });

  it("rejects a forward that is neither an address nor inbox", () => {
    const yaml = variant((d) => (d.watches[0].categories.rejection.forward = "rejected"));
    expect(issuesOf(yaml).join("\n")).toMatch(/^watches\[0\]\.categories\.rejection\.forward: /m);
  });

  it("rejects a custom detector whose regex does not compile", () => {
    const yaml = variant((d) => (d.redact = { custom: [{ kind: "MEMBER", pattern: "M(\\d+" }] }));
    expect(issuesOf(yaml).join("\n")).toMatch(/^redact\.custom\[0\]\.pattern: invalid regex/m);
  });

  it("rejects a reveal of an unknown placeholder kind", () => {
    const yaml = variant((d) => (d.watches[0].categories.interview.reveal = ["PHONE", "SHOE"]));
    expect(issuesOf(yaml)).toContain('watches[0].categories.interview.reveal: unknown kind "SHOE"');
  });

  it("accepts a reveal of a custom detector's kind", () => {
    const yaml = variant((d) => {
      d.redact = { custom: [{ kind: "MEMBER", pattern: "M-\\d{6}" }] };
      d.watches[0].categories.interview.reveal = ["MEMBER"];
    });
    expect(() => loadConfig(yaml, { crons: CRONS })).not.toThrow();
  });

  it("rejects a self-test that names a missing watch", () => {
    const yaml = variant((d) => (d.selftest.watch = "nope"));
    expect(issuesOf(yaml)).toContain('selftest.watch: unknown watch "nope"');
  });

  it("rejects duplicate watch names and reserved category names", () => {
    const yaml = variant((d) => {
      d.watches[1].name = "jobs";
      d.watches[2].categories.uncertain = { description: "x", forward: "inbox" };
    });
    expect(issuesOf(yaml)).toEqual(
      expect.arrayContaining(['watches[1].name: duplicate watch "jobs"', 'watches[2].categories.uncertain: "uncertain" is reserved']),
    );
  });
});
