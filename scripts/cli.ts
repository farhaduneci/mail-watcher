// The real tools behind the setup and deploy scripts: wrangler as a child process, the Cloudflare
// API with wrangler's login, a hidden prompt, and the build.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { build } from "./build";
import { CONFIG_PATH, requireFiles, WRANGLER_PATH } from "./paths";
import type { Tools } from "./setup";

export { CONFIG_PATH, WRANGLER_PATH };

function run(args: string[], input?: string, quiet = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (!quiet) process.stdout.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args.join(" ")} exited with ${code}`))));
    child.stdin.end(input ?? "");
  });
}

let token: string | undefined;
async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  token ??= (JSON.parse(await run(["auth", "token", "--json"], undefined, true)) as { token: string }).token;
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; result: unknown; errors?: { message: string }[] };
  if (!json.success) throw new Error(`${method} ${path}: ${json.errors?.map((e) => e.message).join("; ") || res.status}`);
  return json.result;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide what is typed: echo nothing after the question.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

export function cli(): Tools & { build(): Promise<unknown> } {
  requireFiles(CONFIG_PATH, WRANGLER_PATH);
  return {
    build: () => build({ config: CONFIG_PATH, wrangler: WRANGLER_PATH }),
    wrangler: (args, input) => run([...args, "-c", WRANGLER_PATH], input),
    api,
    prompt,
    writeWrangler: (text) => writeFileSync(WRANGLER_PATH, text),
    log: (line) => console.log(line),
  };
}

export const readText = (path: string) => readFileSync(path, "utf8");
