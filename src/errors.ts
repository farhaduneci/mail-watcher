// Error helpers shared by the Worker and the scripts.

/** A secret named in the config is not set on the Worker: a config problem, not a provider one. */
export class MissingSecretError extends Error {
  constructor(readonly secret: string) {
    super(`secret ${secret} is not set`);
  }
}

/** The error's message, trimmed for ledger rows and alerts. */
export const errorText = (e: unknown, max = 500): string => String((e as Error)?.message ?? e).slice(0, max);

/** A channel result string ("error: ...") caused by a missing secret. */
export const isMissingSecret = (result: string): boolean => /^error: secret \S+ is not set$/.test(result);
