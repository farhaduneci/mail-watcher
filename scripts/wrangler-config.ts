// Reads wrangler.jsonc without pulling in wrangler: comments and trailing commas stripped.
import { readFileSync } from "node:fs";

export function parseJsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export interface WranglerConfig {
  name: string;
  d1_databases?: { binding: string; database_name: string; database_id?: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  triggers?: { crons?: string[] };
}

export const readWrangler = (path: string): WranglerConfig => parseJsonc(readFileSync(path, "utf8"));
