// The redactor, shaped like Presidio: every enabled detector scans the same normalized text and
// returns scored spans; overlaps are settled once; replacement runs right to left. Detectors never
// see each other's output, so placeholders can't be broken up (docs/research/pii-redaction-workers.md).
import type { Config } from "../config/schema";
import { builtinDetectors, customDetector, type Detector } from "./detectors";

export type RedactSettings = Config["redact"];

export interface Span {
  start: number;
  end: number;
  kind: string;
  score: number;
  /** The original text. Kept in memory for reveals; never sent to a model or stored. */
  value: string;
}

export interface Redacted {
  /** The normalized text with each span replaced by `[KIND]`. */
  text: string;
  /** Spans into the normalized text, in order. */
  spans: Span[];
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes HTML entities and drops invisible characters, so detectors see what a reader sees. */
export function normalize(text: string): string {
  return text
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (m, dec, hex, name) => {
      if (dec || hex) {
        const code = parseInt(dec ?? hex, dec ? 10 : 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return NAMED[name.toLowerCase()] ?? m;
    })
    .replace(/ /g, " ")
    .replace(/[​-‍⁠﻿]/g, "");
}

/**
 * Overlapping spans merge into their union, so no part of a sensitive value survives; the union
 * takes the kind of its highest-scoring span, then the longest.
 */
function resolve(spans: Omit<Span, "value">[]): Omit<Span, "value">[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Omit<Span, "value">[] = [];
  let lead: Omit<Span, "value"> | undefined; // the member that names the current union
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (s.score > lead!.score || (s.score === lead!.score && s.end - s.start > lead!.end - lead!.start)) {
        lead = s;
        last.kind = s.kind;
        last.score = s.score;
      }
    } else {
      lead = s;
      out.push({ ...s });
    }
  }
  return out;
}

const cache = new WeakMap<RedactSettings, Detector[]>();

function detectorsFor(settings: RedactSettings): Detector[] {
  let list = cache.get(settings);
  if (!list) {
    list = [...builtinDetectors(settings), ...settings.custom.map(customDetector)];
    cache.set(settings, list);
  }
  return list;
}

export function redact(input: string, settings: RedactSettings): Redacted {
  const text = normalize(input);
  const found = detectorsFor(settings).flatMap((d) => d(text));
  const spans = resolve(found).map((s) => ({ ...s, value: text.slice(s.start, s.end) }));
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    out = `${out.slice(0, spans[i].start)}[${spans[i].kind}]${out.slice(spans[i].end)}`;
  }
  return { text: out, spans };
}

/** Original values per kind, for the kinds a category reveals. */
export function reveals(spans: Span[], kinds: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const kind of kinds) {
    const values = [...new Set(spans.filter((s) => s.kind === kind).map((s) => s.value))];
    if (values.length) out[kind] = values;
  }
  return out;
}
