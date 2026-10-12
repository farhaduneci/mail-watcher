/** Replaces {name} placeholders; unknown names become empty. */
export const fill = (template: string, vars: Record<string, unknown>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));

/** Like fill, with every value URL-encoded (for link templates). */
export const fillUrl = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(vars[key] ?? ""));
