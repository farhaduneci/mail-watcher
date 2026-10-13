import type { Secrets } from "./channels/types";

/** Secrets are Worker secrets named in the config, so they are looked up by name. */
export const secretsOf = (env: Env): Secrets => (name) => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value ? value : undefined;
};

/** A deep copy of `value` with every `*_secret` value (a secret name) replaced by `map(name)`. */
export function mapSecretNames(value: unknown, map: (name: string) => unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => mapSecretNames(v, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapSecretNames(v, map, k)]));
  }
  return key.endsWith("_secret") && typeof value === "string" ? map(value) : value;
}

/** Every secret name in the config, in config order, once. */
export function secretNames(config: unknown): string[] {
  const names = new Set<string>();
  mapSecretNames(config, (name) => names.add(name));
  return [...names];
}
