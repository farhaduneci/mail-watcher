// Build-time config loading: YAML → defaults merged → zod → cross-checks → the bundled config.
// Runs in Node only (scripts and tests); the Worker imports the bundled JSON and has no YAML parser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { CHANNELS } from "../channels/registry";
import { BUILTIN_KINDS, type Config, configSchema, DROP_MIN_CONFIDENCE, RESERVED_CATEGORIES } from "./schema";

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid config:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

const DEFAULTS = parse(readFileSync(join(import.meta.dirname, "../../config/defaults.yaml"), "utf8"));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; anything else in `over` replaces `base`. */
function merge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

export const pathOf = (path: readonly PropertyKey[]) =>
  path.reduce<string>((s, p) => (typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), "");

export interface LoadOptions {
  /** `triggers.crons` from wrangler.jsonc. */
  crons: string[];
}

export function loadConfig(yamlText: string, { crons }: LoadOptions): Config {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      const at = e.linePos?.[0];
      throw new ConfigError([`YAML syntax error${at ? ` at line ${at.line}, column ${at.col}` : ""}: ${e.message.split("\n")[0]}`]);
    }
    throw e;
  }
  if (!isObject(raw)) throw new ConfigError(["the config must be a YAML mapping"]);

  const issues: string[] = [];
  const known = CHANNELS.map((c) => c.type);
  if (isObject(raw.channels)) {
    for (const [name, inst] of Object.entries(raw.channels)) {
      const type = isObject(inst) ? inst.type : undefined;
      if (!known.includes(type as string)) {
        issues.push(`channels.${name}.type: unknown channel type ${JSON.stringify(type)} (known: ${known.join(", ")})`);
      }
    }
  }

  const result = configSchema(CHANNELS).safeParse(merge(DEFAULTS, raw));
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = pathOf(issue.path);
      // Unknown channel types are reported above, more readably.
      if (issue.code === "invalid_union" && /^channels\.[^.]+(\.type)?$/.test(path)) continue;
      issues.push(`${path || "(root)"}: ${issue.message}`);
    }
    throw new ConfigError(issues);
  }
  const config = result.data as Config;
  issues.push(...crossCheck(config, crons));
  if (issues.length) throw new ConfigError(issues);

  for (const watch of config.watches) {
    for (const category of Object.values(watch.categories)) {
      category.min_confidence ??= category.forward ? 0 : DROP_MIN_CONFIDENCE;
    }
  }
  return config;
}

function crossCheck(config: Config, crons: string[]): string[] {
  const issues: string[] = [];
  const channels = (path: string, names: string[]) => {
    for (const n of names) if (!config.channels[n]) issues.push(`${path}: unknown channel "${n}"`);
  };

  const kinds = new Set<string>([...BUILTIN_KINDS, ...config.redact.custom.map((d) => d.kind)]);
  config.redact.custom.forEach((d, i) => {
    try {
      new RegExp(d.pattern, d.flags);
    } catch (e) {
      issues.push(`redact.custom[${i}].pattern: invalid regex (${(e as Error).message})`);
    }
  });

  const seen = new Set<string>();
  config.watches.forEach((watch, i) => {
    const at = `watches[${i}]`;
    if (seen.has(watch.name)) issues.push(`${at}.name: duplicate watch "${watch.name}"`);
    seen.add(watch.name);
    for (const [name, category] of Object.entries(watch.categories)) {
      if (RESERVED_CATEGORIES.includes(name)) issues.push(`${at}.categories.${name}: "${name}" is reserved`);
      channels(`${at}.categories.${name}.notify`, category.notify);
      for (const k of category.reveal) if (!kinds.has(k)) issues.push(`${at}.categories.${name}.reveal: unknown kind "${k}"`);
    }
    channels(`${at}.uncertain.notify`, watch.uncertain.notify);
    channels(`${at}.on_error.notify`, watch.on_error.notify);
    if (!watch.on_error.forward) issues.push(`${at}.on_error: must forward; on_error can never drop mail`);
  });
  channels("default.notify", config.default.notify);
  channels("alerts.channels", config.alerts.channels);
  channels("schedules.digest_channels", config.schedules.digest_channels);

  for (const job of ["selftest", "digest"] as const) {
    const cron = config.schedules[job];
    if (cron && !crons.includes(cron)) issues.push(`schedules.${job}: cron "${cron}" is not in wrangler.jsonc triggers.crons`);
  }
  if (config.selftest.watch && !seen.has(config.selftest.watch)) issues.push(`selftest.watch: unknown watch "${config.selftest.watch}"`);
  const expected = config.selftest.expect;
  const target = config.watches.find((w) => w.name === (config.selftest.watch ?? config.watches[0].name));
  if (expected && target && !target.categories[expected]) {
    issues.push(`selftest.expect: watch "${target.name}" has no category "${expected}"`);
  }
  return issues;
}
