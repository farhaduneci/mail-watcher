import type { Secrets } from "./channels/types";

/** Secrets are Worker secrets named in the config, so they are looked up by name. */
export const secretsOf = (env: Env): Secrets => (name) => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value ? value : undefined;
};
