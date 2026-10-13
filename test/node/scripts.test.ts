import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deploy } from "../../scripts/deploy";
import { setup, type Tools } from "../../scripts/setup";
import { CHANNELS } from "../../src/channels/registry";
import { loadConfig } from "../../src/config/load";
import { jsonSchema, markdownReference } from "../../src/config/reference";

const root = join(import.meta.dirname, "../..");
const CONFIG = loadConfig(readFileSync(join(root, "test/fixtures/config.yaml"), "utf8"), { crons: ["0 7 * * *", "0 8 * * MON"] });
const WRANGLER = `{
  "name": "mail-watcher",
  // the ledger
  "d1_databases": [{ "binding": "DB", "database_name": "mail-watcher", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "RAW", "bucket_name": "mail-watcher-raw" }],
  "triggers": { "crons": ["0 7 * * *", "0 8 * * MON"] }
}`;

type Api = Record<string, (body?: any) => unknown>;

function fakeTools(api: Api = {}, answers: Record<string, string> = {}) {
  const routes: Api = {
    "GET /accounts": () => [{ id: "acc1", name: "Owner" }],
    "GET /accounts/acc1/d1/database?name=mail-watcher": () => [],
    "POST /accounts/acc1/d1/database": () => ({ uuid: "d1-uuid" }),
    "GET /accounts/acc1/r2/buckets": () => ({ buckets: [] }),
    "POST /accounts/acc1/r2/buckets": () => ({}),
    "GET /zones?name=example.com": () => [{ id: "zone1" }],
    "GET /zones/zone1/email/routing/rules?per_page=50": () => [],
    "POST /zones/zone1/email/routing/rules": () => ({}),
    "GET /accounts/acc1/email/routing/addresses?per_page=50": () => [{ email: "owner@example.com", verified: "2026-01-01" }],
    "POST /accounts/acc1/email/routing/addresses": () => ({}),
    ...api,
  };
  const tools = {
    wrangler: vi.fn(async (_args: string[], _input?: string) => ""),
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      const route = routes[`${method} ${path}`];
      if (!route) throw new Error(`unexpected API call ${method} ${path}`);
      return route(body);
    }),
    prompt: vi.fn(async (question: string) => answers[question.match(/[A-Z][A-Z0-9_]+/)![0]] ?? ""),
    writeWrangler: vi.fn((_text: string) => {}),
    log: vi.fn((_line: string) => {}),
  } satisfies Tools;
  return tools;
}

const posts = (tools: ReturnType<typeof fakeTools>, path: string) =>
  tools.api.mock.calls.filter(([m, p]) => m === "POST" && p === path).map(([, , body]) => body as any);

describe("setup", () => {
  it("creates the D1 database and writes its id into wrangler.jsonc", async () => {
    const tools = fakeTools();
    await setup(CONFIG, WRANGLER, tools);

    expect(posts(tools, "/accounts/acc1/d1/database")).toEqual([{ name: "mail-watcher" }]);
    const written = tools.writeWrangler.mock.calls[0][0];
    expect(written).toContain('"database_name": "mail-watcher", "database_id": "d1-uuid"');
    expect(written).toContain("// the ledger");
  });

  it("reuses an existing database", async () => {
    const tools = fakeTools({ "GET /accounts/acc1/d1/database?name=mail-watcher": () => [{ name: "mail-watcher", uuid: "old-uuid" }] });
    await setup(CONFIG, WRANGLER, tools);

    expect(posts(tools, "/accounts/acc1/d1/database")).toEqual([]);
    expect(tools.writeWrangler.mock.calls[0][0]).toContain('"database_id": "old-uuid"');
  });

  it("leaves a database id that is already set", async () => {
    const tools = fakeTools();
    await setup(CONFIG, WRANGLER.replace('"migrations_dir"', '"database_id": "set", "migrations_dir"'), tools);
    expect(tools.api.mock.calls.some(([, p]) => p.includes("/d1/"))).toBe(false);
    expect(tools.writeWrangler).not.toHaveBeenCalled();
  });

  it("creates the R2 bucket when retention is on", async () => {
    const tools = fakeTools();
    await setup(CONFIG, WRANGLER, tools);
    expect(posts(tools, "/accounts/acc1/r2/buckets")).toEqual([{ name: "mail-watcher-raw" }]);
  });

  it("applies migrations remotely", async () => {
    const tools = fakeTools();
    await setup(CONFIG, WRANGLER, tools);
    expect(tools.wrangler).toHaveBeenCalledWith(["d1", "migrations", "apply", "DB", "--remote"]);
  });

  it("prompts once for each secret named in the config and skips empty answers", async () => {
    const tools = fakeTools({}, { TYPESAFE_API_KEY: "k1" });
    await setup(CONFIG, WRANGLER, tools);

    expect(tools.prompt.mock.calls.map(([q]) => q.match(/[A-Z][A-Z0-9_]+/)![0])).toEqual(["TYPESAFE_API_KEY", "TELEGRAM_BOT_TOKEN"]);
    const puts = tools.wrangler.mock.calls.filter(([a]) => a[0] === "secret");
    expect(puts).toEqual([[["secret", "put", "TYPESAFE_API_KEY"], "k1"]]);
  });

  it("routes each watch's literal addresses to the worker, using the base address for plus-tags", async () => {
    const tools = fakeTools();
    await setup(CONFIG, WRANGLER, tools);

    const rules = posts(tools, "/zones/zone1/email/routing/rules");
    expect(rules.map((r) => r.matchers[0].value)).toEqual(["jobs@example.com", "hi@example.com"]);
    expect(rules[0]).toMatchObject({ enabled: true, matchers: [{ type: "literal", field: "to" }], actions: [{ type: "worker", value: ["mail-watcher"] }] });
  });

  it("leaves an address that is already routed elsewhere alone", async () => {
    const tools = fakeTools({
      "GET /zones/zone1/email/routing/rules?per_page=50": () => [
        { matchers: [{ type: "literal", field: "to", value: "jobs@example.com" }], actions: [{ type: "worker", value: ["job-mail-worker"] }] },
        { matchers: [{ type: "literal", field: "to", value: "hi@example.com" }], actions: [{ type: "worker", value: ["mail-watcher"] }] },
      ],
    });
    await setup(CONFIG, WRANGLER, tools);

    expect(posts(tools, "/zones/zone1/email/routing/rules")).toEqual([]);
    expect(tools.log.mock.calls.map(([l]) => l).join("\n")).toMatch(/jobs@example.com.*job-mail-worker/);
  });

  it("skips match globs that are not a single address", async () => {
    const config = structuredClone(CONFIG);
    config.watches[0].match.to = ["*@example.com"];
    const tools = fakeTools();
    await setup(config, WRANGLER, tools);

    expect(posts(tools, "/zones/zone1/email/routing/rules").map((r) => r.matchers[0].value)).toEqual(["hi@example.com"]);
    expect(tools.log.mock.calls.map(([l]) => l).join("\n")).toContain("*@example.com");
  });

  it("registers forward destinations that are not registered yet", async () => {
    const tools = fakeTools();
    await setup(CONFIG, WRANGLER, tools);
    expect(posts(tools, "/accounts/acc1/email/routing/addresses")).toEqual([
      { email: "owner+attention@example.com" },
      { email: "owner+rejected@example.com" },
    ]);
  });
});

describe("deploy", () => {
  it("builds, migrates and deploys, in that order", async () => {
    const steps: string[] = [];
    await deploy({
      build: async () => void steps.push("build"),
      wrangler: async (args) => void steps.push(args.join(" ")),
    });
    expect(steps).toEqual(["build", "d1 migrations apply DB --remote", "deploy"]);
  });

  it("stops before deploying when the build fails", async () => {
    const wrangler = vi.fn(async () => "");
    await expect(
      deploy({
        build: async () => {
          throw new Error("invalid config");
        },
        wrangler,
      }),
    ).rejects.toThrow("invalid config");
    expect(wrangler).not.toHaveBeenCalled();
  });
});

describe("generated files", () => {
  it("keeps the config reference and JSON Schema in sync with the schema", () => {
    expect(readFileSync(join(root, "docs/config-reference.md"), "utf8")).toBe(markdownReference(CHANNELS));
    expect(JSON.parse(readFileSync(join(root, "mail-watcher.schema.json"), "utf8"))).toEqual(jsonSchema(CHANNELS));
  });
});
