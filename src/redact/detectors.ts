// Built-in and custom detectors. Each returns spans of one kind found in the original text.
import { findPhoneNumbersInText, type CountryCode } from "libphonenumber-js/max";
import { LinkifyIt } from "linkify-it";
import type { Span, RedactSettings } from "./index";
import PATTERNS from "./patterns.json";
import SECRETS from "./secrets.json";

export type Found = Omit<Span, "value">;
export type Detector = (text: string) => Found[];

/** Overlap tie-breakers: secrets beat everything, context-gated guesses lose. */
const SCORE = { SECRET: 1, EMAIL: 0.95, LINK: 0.9, NUMBER: 0.85, PHONE: 0.8, ADDRESS: 0.5, CODE: 0.4 } as const;

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function mod97(iban: string): boolean {
  const s = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of s) {
    const v = ch >= "A" ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    rest = (rest * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rest === 1;
}

const VALIDATORS = { luhn: (v: string) => luhn(v.replace(/\D/g, "")), mod97: (v: string) => mod97(v.replace(/\s/g, "").toUpperCase()) };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** Matches any of the words on word-ish boundaries (letters of any script). */
const wordsRegex = (words: string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");

function* matches(re: RegExp, text: string) {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    yield { start: m.index, end: m.index + m[0].length, value: m[0] };
  }
}

const NEGATIVE = wordsRegex(PATTERNS.negative_context.words);
/** True when a hit reads as a reference number: right after `#` or a word like "order". */
function isReference(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - PATTERNS.negative_context.window), start);
  if (/#\s*$/.test(before)) return true;
  const words = [...before.matchAll(new RegExp(NEGATIVE.source, "giu"))];
  return words.length > 0 && /^[\s:.#-]*$/.test(before.slice(words[words.length - 1].index! + words[words.length - 1][0].length));
}

/**
 * Tokens near a context word: the first token after the word, else the nearest one before it,
 * each within `window` characters.
 */
function nearContext(text: string, context: RegExp, token: RegExp, window: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const word of matches(context, text)) {
    const after = text.slice(word.end, word.end + window);
    const next = matches(new RegExp(token.source, token.flags.replace("g", "") + "g"), after).next();
    if (!next.done) {
      out.push({ start: word.end + next.value.start, end: word.end + next.value.end });
      continue;
    }
    const from = Math.max(0, word.start - window);
    const before = [...matches(new RegExp(token.source, token.flags.replace("g", "") + "g"), text.slice(from, word.start))];
    const last = before[before.length - 1];
    if (last) out.push({ start: from + last.start, end: from + last.end });
  }
  return out;
}

const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: false, fuzzyIP: true });
const SECRET_RULES = SECRETS.rules.map((r) => new RegExp(r.pattern, `g${(r as { flags?: string }).flags ?? ""}`));
const LONG_TOKEN = /[A-Za-z0-9_\-+/=]{32,}/g;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const span = (kind: keyof typeof SCORE) => (m: { start: number; end: number }): Found => ({ start: m.start, end: m.end, kind, score: SCORE[kind] });

const DATE = new RegExp(PATTERNS.phone.dates.join("|"));
/**
 * Regions with variable-length numbers (DE, IT) accept dates and short runs as valid. A number
 * written without + needs `min_national_digits` digits and must not look like a date.
 */
function plausibleNational(raw: string): boolean {
  if (raw.startsWith("+")) return true;
  return raw.replace(/\D/g, "").length >= PATTERNS.phone.min_national_digits && !DATE.test(raw);
}

const DETECTORS: Record<keyof RedactSettings["detectors"], (settings: RedactSettings) => Detector> = {
  secret: () => (text) => [
    ...SECRET_RULES.flatMap((re) => [...matches(re, text)]),
    ...[...matches(LONG_TOKEN, text)].filter((m) => /\d/.test(m.value) && /[A-Za-z]/.test(m.value) && entropy(m.value) >= 3.5),
  ].map(span("SECRET")),

  email: () => {
    const re = new RegExp(PATTERNS.email, "g");
    return (text) => [...matches(re, text)].map(span("EMAIL"));
  },

  link: () => (text) => (linkify.match(text) ?? []).map((m) => span("LINK")({ start: m.index, end: m.lastIndex })),

  phone: (settings) => {
    const candidates = new RegExp(PATTERNS.phone.candidate, "g");
    // libphonenumber is the expensive part, so it only sees digit runs that could be numbers.
    return (text) => {
      const out: Found[] = [];
      for (const c of matches(candidates, text)) {
        const seen = new Set<string>();
        // With no regions, only numbers written with + are found.
        for (const region of (settings.phone_regions.length ? settings.phone_regions : [undefined]) as (CountryCode | undefined)[]) {
          for (const hit of findPhoneNumbersInText(c.value, region ? { defaultCountry: region } : undefined)) {
            const start = c.start + hit.startsAt;
            const end = c.start + hit.endsAt;
            const key = `${start}:${end}`;
            if (seen.has(key) || !hit.number.isValid() || isReference(text, start)) continue;
            if (!plausibleNational(text.slice(start, end))) continue;
            seen.add(key);
            out.push(span("PHONE")({ start, end }));
          }
        }
      }
      return out;
    };
  },

  code: () => {
    const context = wordsRegex(PATTERNS.code.context);
    const token = new RegExp(PATTERNS.code.token, "g");
    return (text) => nearContext(text, context, token, PATTERNS.code.window).filter((m) => text[m.start - 1] !== "#").map(span("CODE"));
  },

  number: () => {
    const card = new RegExp(PATTERNS.card, "g");
    const iban = new RegExp(PATTERNS.iban, "g");
    const context = wordsRegex(PATTERNS.account.context);
    const account = new RegExp(PATTERNS.account.token, "g");
    return (text) => [
      ...[...matches(card, text)].filter((m) => luhn(m.value.replace(/\D/g, "")) && !isReference(text, m.start)),
      ...[...matches(iban, text)].filter((m) => mod97(m.value.replace(/\s/g, ""))),
      ...nearContext(text, context, account, PATTERNS.account.window),
    ].map(span("NUMBER"));
  },

  address: () => {
    const res = PATTERNS.address.map((p) => new RegExp(p, "gu"));
    return (text) => res.flatMap((re) => [...matches(re, text)]).map(span("ADDRESS"));
  },
};

export function builtinDetectors(settings: RedactSettings): Detector[] {
  return (Object.keys(DETECTORS) as (keyof typeof DETECTORS)[]).filter((k) => settings.detectors[k]).map((k) => DETECTORS[k](settings));
}

export function customDetector(d: RedactSettings["custom"][number]): Detector {
  const flags = d.flags.includes("g") ? d.flags : `${d.flags}g`;
  const re = new RegExp(d.pattern, flags);
  const validate = d.validator ? VALIDATORS[d.validator] : () => true;
  const found = (m: { start: number; end: number }): Found => ({ start: m.start, end: m.end, kind: d.kind, score: d.score });
  if (!d.context.length) return (text) => [...matches(re, text)].filter((m) => validate(m.value)).map(found);
  const context = wordsRegex(d.context);
  return (text) =>
    [...matches(re, text)]
      .filter((m) => validate(m.value))
      .filter((m) => [...matches(context, text.slice(Math.max(0, m.start - d.window), m.end + d.window))].length > 0)
      .map(found);
}
