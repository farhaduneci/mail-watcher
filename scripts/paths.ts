// File names and commands the scripts share.
import { existsSync } from "node:fs";

export const CONFIG_PATH = "mailsentry.yaml";
export const WRANGLER_PATH = "wrangler.jsonc";
export const MIGRATE = ["d1", "migrations", "apply", "DB", "--remote"];

const EXAMPLES: Record<string, string> = { [CONFIG_PATH]: "mailsentry.example.yaml", [WRANGLER_PATH]: "wrangler.example.jsonc" };

/** Exits with a hint when a private file hasn't been created from its example yet. */
export function requireFiles(...files: string[]): void {
  for (const file of files) {
    if (existsSync(file)) continue;
    const example = EXAMPLES[file];
    console.error(`${file} not found${example ? `: copy ${example} to ${file} and edit it` : ""}.`);
    process.exit(1);
  }
}
