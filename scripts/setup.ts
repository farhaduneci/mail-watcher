// First-time setup, idempotent: creates D1 (and R2), applies migrations, prompts for each secret
// named in the config, routes each watch's addresses to the worker and registers forward
// destinations so Cloudflare sends their verification mails. Never moves an address that is
// already routed elsewhere; that switch stays a deliberate step.
import type { Action, Config } from "../src/config/schema";
import { errorText } from "../src/errors";
import { secretNames } from "../src/secrets";
import { MIGRATE } from "./paths";
import { parseJsonc, type WranglerConfig } from "./wrangler-config";

export interface Tools {
  /** Runs `wrangler <args> -c <wrangler.jsonc>`, with `input` on stdin. */
  wrangler(args: string[], input?: string): Promise<string>;
  /** Cloudflare API call with the wrangler login; returns `result`. */
  api(method: "GET" | "POST", path: string, body?: unknown): Promise<any>;
  /** Asks for a secret value without echoing it. */
  prompt(question: string): Promise<string>;
  writeWrangler(text: string): void;
  log(line: string): void;
}

/** Addresses Email Routing can match literally: plain globs, and `local+*@domain` as `local@domain` (subaddressing). */
export function routableAddresses(config: Config, log: (line: string) => void): string[] {
  const out = new Set<string>();
  for (const watch of config.watches) {
    for (const g of watch.match.to ?? []) {
      const plus = g.match(/^([^*?+@]+)\+\*@([^*?@]+)$/);
      if (plus) out.add(`${plus[1]}@${plus[2]}`.toLowerCase());
      else if (!/[*?]/.test(g)) out.add(g.toLowerCase());
      else log(`skip ${g} (watch ${watch.name}): not a single address; add an Email Routing rule or catch-all for it by hand`);
    }
  }
  return [...out];
}

export function forwardAddresses(config: Config): string[] {
  const actions: Action[] = [config.default, ...config.watches.flatMap((w) => [w.uncertain, w.on_error, ...Object.values(w.categories)])];
  return [...new Set([config.mailbox.inbox, ...actions.map((a) => (a.forward === "inbox" ? config.mailbox.inbox : a.forward)).filter((a): a is string => !!a)])];
}

async function database(wranglerText: string, tools: Tools, account: string): Promise<void> {
  const wrangler = parseJsonc(wranglerText) as WranglerConfig;
  const db = wrangler.d1_databases?.find((d) => d.binding === "DB");
  if (!db) throw new Error("wrangler.jsonc has no d1_databases entry with binding DB");
  if (db.database_id) return tools.log(`D1 ${db.database_name}: already configured`);

  const existing = ((await tools.api("GET", `/accounts/${account}/d1/database?name=${encodeURIComponent(db.database_name)}`)) as { name: string; uuid: string }[]).find(
    (d) => d.name === db.database_name,
  );
  const id = existing?.uuid ?? ((await tools.api("POST", `/accounts/${account}/d1/database`, { name: db.database_name })) as { uuid: string }).uuid;
  tools.log(`D1 ${db.database_name}: ${existing ? "found" : "created"} (${id})`);
  const name = JSON.stringify(db.database_name);
  tools.writeWrangler(wranglerText.replace(new RegExp(`("database_name":\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`), `$1, "database_id": "${id}"`));
}

async function bucket(config: Config, wrangler: WranglerConfig, tools: Tools, account: string): Promise<void> {
  const raw = wrangler.r2_buckets?.find((b) => b.binding === "RAW");
  if (!raw || config.retain_days === 0) return tools.log("R2: retention off, no bucket needed");
  const { buckets } = (await tools.api("GET", `/accounts/${account}/r2/buckets`)) as { buckets: { name: string }[] };
  if (buckets.some((b) => b.name === raw.bucket_name)) return tools.log(`R2 ${raw.bucket_name}: exists`);
  await tools.api("POST", `/accounts/${account}/r2/buckets`, { name: raw.bucket_name });
  tools.log(`R2 ${raw.bucket_name}: created`);
}

async function secrets(config: Config, tools: Tools): Promise<void> {
  for (const name of secretNames(config)) {
    const value = (await tools.prompt(`Value for secret ${name} (empty keeps the current one): `)).trim();
    if (!value) {
      tools.log(`secret ${name}: unchanged`);
      continue;
    }
    await tools.wrangler(["secret", "put", name], value);
    tools.log(`secret ${name}: set`);
  }
}

interface Rule {
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
}

async function routing(config: Config, worker: string, tools: Tools): Promise<void> {
  const byDomain = new Map<string, string[]>();
  for (const address of routableAddresses(config, tools.log)) {
    const domain = address.split("@")[1];
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), address]);
  }
  for (const [domain, addresses] of byDomain) {
    const [zone] = (await tools.api("GET", `/zones?name=${encodeURIComponent(domain)}`)) as { id: string }[];
    if (!zone) {
      tools.log(`skip ${addresses.join(", ")}: ${domain} is not a zone in this account`);
      continue;
    }
    const rules = (await tools.api("GET", `/zones/${zone.id}/email/routing/rules?per_page=50`)) as Rule[];
    for (const address of addresses) {
      const rule = rules.find((r) => r.matchers.some((m) => m.type === "literal" && m.field === "to" && m.value?.toLowerCase() === address));
      if (rule) {
        const target = rule.actions.map((a) => `${a.type}${a.value ? ` ${a.value.join(",")}` : ""}`).join("; ");
        tools.log(
          rule.actions.some((a) => a.type === "worker" && a.value?.includes(worker))
            ? `route ${address}: already goes to ${worker}`
            : `route ${address}: left alone, it goes to ${target}; move it to ${worker} in the dashboard when ready`,
        );
        continue;
      }
      await tools.api("POST", `/zones/${zone.id}/email/routing/rules`, {
        name: `mail-watcher: ${address}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: address }],
        actions: [{ type: "worker", value: [worker] }],
      });
      tools.log(`route ${address}: → ${worker}`);
    }
  }
}

async function destinations(config: Config, tools: Tools, account: string): Promise<void> {
  const known = new Set(
    ((await tools.api("GET", `/accounts/${account}/email/routing/addresses?per_page=50`)) as { email: string }[]).map((a) => a.email.toLowerCase()),
  );
  for (const email of forwardAddresses(config)) {
    if (known.has(email.toLowerCase())) continue;
    await tools.api("POST", `/accounts/${account}/email/routing/addresses`, { email });
    tools.log(`destination ${email}: registered; click the link in the verification mail Cloudflare sent`);
  }
}

export async function setup(config: Config, wranglerText: string, tools: Tools): Promise<void> {
  const wrangler = parseJsonc(wranglerText) as WranglerConfig;
  const [account] = (await tools.api("GET", "/accounts")) as { id: string }[];
  if (!account) throw new Error("no Cloudflare account visible to the wrangler login");
  await database(wranglerText, tools, account.id);
  await bucket(config, wrangler, tools, account.id);
  await tools.wrangler(MIGRATE);
  await secrets(config, tools);
  await routing(config, wrangler.name, tools);
  await destinations(config, tools, account.id);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { cli, readText, WRANGLER_PATH } = await import("./cli");
  const tools = cli();
  try {
    const config = (await tools.build()) as Config;
    await setup(config, readText(WRANGLER_PATH), tools);
    console.log("\nSetup done. Verify any new destinations, then run `npm run deploy`.");
  } catch (e) {
    console.error(errorText(e, 2000));
    process.exit(1);
  }
}
