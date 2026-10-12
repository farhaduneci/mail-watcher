import type { Config, Watch } from "./config/schema";

const cache = new Map<string, RegExp>();

/** `*` matches any run, `?` one character; case-insensitive, anchored. */
export function glob(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    re = new RegExp(`^${source}$`, "is");
    cache.set(pattern, re);
  }
  return re;
}

const any = (globs: string[] | undefined, value: string) => !globs || globs.some((g) => glob(g).test(value));

/** The first watch whose match fits, or undefined. */
export function selectWatch(config: Config, mail: { to: string; from: string; subject: string }): Watch | undefined {
  return config.watches.find((w) => any(w.match.to, mail.to) && any(w.match.from, mail.from) && any(w.match.subject, mail.subject));
}
