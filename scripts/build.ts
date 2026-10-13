// Validates the app config and bundles it for the Worker:
//   channels registry → mail-watcher.yaml validated → generated/config.json,
//   plus the editor JSON Schema and docs/config-reference.md.
// Flags: --config <yaml> (default mail-watcher.yaml), --wrangler <jsonc> (default wrangler.jsonc),
// --typecheck (registry, and an example bundle when none exists, so tsc can resolve it).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CONFIG_PATH, requireFiles, WRANGLER_PATH } from "./paths";
import { generateRegistry } from "./registry";
import { readWrangler } from "./wrangler-config";

export interface BuildOptions {
  config: string;
  wrangler: string;
  out?: string;
}

/** Validates and writes the bundle. Throws ConfigError with readable issues. */
export async function build({ config, wrangler, out = "generated/config.json" }: BuildOptions) {
  generateRegistry();
  const { loadConfig } = await import("../src/config/load");
  const { CHANNELS } = await import("../src/channels/registry");
  const { jsonSchema, markdownReference } = await import("../src/config/reference");

  const bundle = loadConfig(readFileSync(config, "utf8"), { crons: readWrangler(wrangler).triggers?.crons ?? [] });
  mkdirSync("generated", { recursive: true });
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync("mail-watcher.schema.json", `${JSON.stringify(jsonSchema(CHANNELS), null, 2)}\n`);
  writeFileSync("docs/config-reference.md", markdownReference(CHANNELS));
  return bundle;
}

async function main() {
  const { values } = parseArgs({
    options: { config: { type: "string" }, wrangler: { type: "string" }, typecheck: { type: "boolean" } },
  });
  if (values.typecheck) {
    generateRegistry();
    if (existsSync("generated/config.json")) return;
    await build({ config: "mail-watcher.example.yaml", wrangler: "wrangler.example.jsonc" });
    return;
  }
  const config = values.config ?? CONFIG_PATH;
  const wrangler = values.wrangler ?? WRANGLER_PATH;
  requireFiles(config, wrangler);
  const { ConfigError } = await import("../src/config/load");
  try {
    const bundle = await build({ config, wrangler });
    console.log(`config ok: ${bundle.watches.length} watch(es), ${Object.keys(bundle.channels).length} channel(s) → generated/config.json`);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`${config}: ${e.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
