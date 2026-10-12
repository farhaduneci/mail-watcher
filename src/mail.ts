// MIME parsing into the plain text the redactor and the models see.
import PostalMime from "postal-mime";

export interface Mail {
  /** Sender address. */
  from: string;
  /** Sender display name, may be empty. */
  name: string;
  subject: string;
  /** Without angle brackets; empty when the mail has none. */
  messageId: string;
  /** Plain text, quoted replies dropped, whitespace tidied, capped. */
  body: string;
}

/** The +tag of an address: "jobs+acme@example.com" → "acme". */
export const tagOf = (address: string): string => address.match(/^[^+@]+\+([^@]+)@/)?.[1] ?? "";

const htmlToText = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, " ")
    .replace(/<div class="gmail_quote[\s\S]*$/i, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

const tidy = (text: string) =>
  text
    .replace(/^>.*$/gm, "")
    .replace(/^On\b.{0,300}\bwrote:\s*$/gm, "")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export async function parseMail(raw: ArrayBuffer, envelopeFrom: string, cap: number): Promise<Mail> {
  const parsed = await PostalMime.parse(raw);
  return {
    from: parsed.from?.address || envelopeFrom,
    name: parsed.from?.name ?? "",
    subject: parsed.subject ?? "",
    messageId: (parsed.messageId ?? "").replace(/^<|>$/g, ""),
    body: tidy(parsed.text || htmlToText(parsed.html || "")).slice(0, cap),
  };
}
