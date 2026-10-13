// Turns the zod schema into the editor JSON Schema and the markdown config reference, so the docs
// can't drift from what the build accepts.
import { z } from "zod";
import type { Channel } from "../channels/types";
import { configSchema } from "./schema";

type Json = Record<string, any>;

export function jsonSchema(channels: readonly Channel[]): Json {
  return z.toJSONSchema(configSchema(channels), { io: "input", unrepresentable: "any" }) as Json;
}

const typeOf = (s: Json): string => {
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (s.enum) return s.enum.map((v: unknown) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (s.anyOf || s.oneOf) return [...new Set((s.anyOf ?? s.oneOf).map(typeOf))].join(" \\| ");
  if (s.type === "array") return `${typeOf(s.items ?? {})}[]`;
  if (s.type === "object" && s.additionalProperties && typeof s.additionalProperties === "object") return "map";
  return s.format ? `${s.type} (${s.format})` : (s.type ?? "any");
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function rows(s: Json, path: string, out: string[], defs: Json) {
  if (s.$ref) s = defs[s.$ref.split("/").pop()];
  const desc = s.description ?? "";
  if (path) {
    const def = s.default !== undefined && typeof s.default !== "object" ? `\`${JSON.stringify(s.default)}\`` : "";
    out.push(`| \`${path}\` | ${typeOf(s)} | ${def} | ${cell(desc)} |`);
  }
  const variants = s.anyOf ?? s.oneOf;
  if (variants && variants.some((v: Json) => v.properties)) {
    for (const v of variants) {
      const tag = Object.entries<Json>(v.properties ?? {}).find(([, p]) => p.const !== undefined);
      const label = tag ? `${path} (${tag[0]}: ${tag[1].const})` : path;
      for (const [k, p] of Object.entries<Json>(v.properties ?? {})) rows(p, `${label}.${k}`, out, defs);
    }
    return;
  }
  for (const [k, p] of Object.entries<Json>(s.properties ?? {})) rows(p, path ? `${path}.${k}` : k, out, defs);
  if (s.type === "array" && s.items?.properties) for (const [k, p] of Object.entries<Json>(s.items.properties)) rows(p, `${path}[].${k}`, out, defs);
  if (s.type === "object" && typeof s.additionalProperties === "object") {
    const inner = s.additionalProperties;
    const variantsInner = inner.anyOf ?? inner.oneOf;
    if (inner.properties || variantsInner) rows({ ...inner, description: undefined }, `${path}.<name>`, out, defs);
  }
}

export function markdownReference(channels: readonly Channel[]): string {
  const schema = jsonSchema(channels);
  const out = [
    "# Config reference",
    "",
    "Generated from the config schema by `npm run build`. Do not edit by hand.",
    "",
    "Every key of `mail-watcher.yaml`. Defaults for prompts, messages and link templates are in",
    "`config/defaults.yaml`. Keys ending in `_secret` hold the *name* of a Worker secret.",
    "",
    "| Key | Type | Default | Description |",
    "|---|---|---|---|",
  ];
  rows(schema, "", out, schema.$defs ?? {});
  return `${out.filter((l, i, a) => !(l.startsWith("| `") && a.indexOf(l) !== i)).join("\n")}\n`;
}
