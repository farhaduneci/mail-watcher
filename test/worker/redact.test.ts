import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/schema";
import { redact } from "../../src/redact";

type Settings = Config["redact"];
const SETTINGS: Settings = env.TEST_CONFIG.redact;
const with_ = (over: Partial<Settings>): Settings => ({ ...SETTINGS, ...over });
const r = (text: string, settings = SETTINGS) => redact(text, settings).text;

describe("redact", () => {
  it.each([
    ["Turkish national phone", "Call me on 0532 123 45 67 today", "Call me on [PHONE] today"],
    ["Turkish international phone", "Call +90 532 123 4567 today", "Call [PHONE] today"],
    ["Iranian national phone", "Call 0912 345 6789 please", "Call [PHONE] please"],
    ["Iranian international phone", "Mobile: +98 912 345 6789", "Mobile: [PHONE]"],
    ["US national phone", "Ring 650-253-0000 anytime", "Ring [PHONE] anytime"],
    ["UK international phone", "Office +44 20 7946 0958.", "Office [PHONE]."],
    ["email", "Write to jane.doe@acme.com.", "Write to [EMAIL]."],
    ["entity-encoded email", "Write to jane&#64;acme.com &amp; me", "Write to [EMAIL] & me"],
    ["URL", "See https://acme.com/jobs/42?ref=mail for more", "See [LINK] for more"],
    ["fuzzy link", "Visit example.com/x?a=1 now", "Visit [LINK] now"],
    ["verification code after the word", "Your verification code is 482913.", "Your verification code is [CODE]."],
    ["code before the word", "482913 is your one-time code", "[CODE] is your one-time code"],
    ["alphanumeric OTP", "OTP: X7K2QP", "OTP: [CODE]"],
    ["card passing Luhn", "Card 4111 1111 1111 1111 on file", "Card [NUMBER] on file"],
    ["TR IBAN passing mod-97", "IBAN TR33 0006 1005 1978 6457 8413 26 thanks", "IBAN [NUMBER] thanks"],
    ["GB IBAN passing mod-97", "Pay GB82 WEST 1234 5698 7654 32.", "Pay [NUMBER]."],
    ["account number near its context word", "Your account number 12345678901 is active", "Your account number [NUMBER] is active"],
    ["street address", "Visit 221B Baker Street, London NW1 6XE soon", "Visit [ADDRESS] soon"],
    ["German street", "Wir sind in der Hauptstraße 5 in Berlin", "Wir sind in der [ADDRESS] in Berlin"],
    ["Turkish street", "Adres: Atatürk Cad. No: 12 Kadıköy", "Adres: [ADDRESS] Kadıköy"],
    ["OpenAI key", "key sk-proj-abcdEFGH1234ijklMNOP5678qrstUVWX9012 here", "key [SECRET] here"],
    ["AWS key", "AKIAIOSFODNN7EXAMPLE leaked", "[SECRET] leaked"],
    ["GitHub token", "ghp_0123456789abcdefghijABCDEFGHIJ012345", "[SECRET]"],
    [
      "JWT",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "Bearer [SECRET]",
    ],
  ])("redacts a %s", (_name, input, expected) => {
    expect(r(input)).toBe(expected);
  });

  it.each([
    ["ISO date", "Interview on 2026-10-08 at 14:30"],
    ["dotted date", "Start date 08.10.2026"],
    ["order number", "Your order #123456789 has shipped"],
    ["invoice number", "Invoice 2026-0042 is attached"],
    ["price", "Total: €1,299.00 incl. VAT"],
    ["card failing Luhn", "Ref 4111 1111 1111 1112"],
    ["IBAN failing mod-97", "Ref GB83 WEST 1234 5698 7654 32"],
    ["bare six-digit number", "We received 482913 applications"],
    ["names and companies", "Hi Sarah Jones, this is Tom from Acme Corp."],
    ["existing placeholders", "Call [PHONE] or visit [LINK]"],
    ["year and room", "Room 1204, building 7, since 1999"],
  ])("leaves a %s alone", (_name, input) => {
    expect(r(input)).toBe(input);
  });

  it("replaces a URL carrying a token as one placeholder, leaking nothing", () => {
    const out = r("Log in: https://app.test/magic?token=ghp_0123456789abcdefghijABCDEFGHIJ012345&u=jane@acme.com done");
    expect(out).toMatch(/^Log in: \[(LINK|SECRET|EMAIL)\] done$/);
  });

  it("settles overlaps once: a card inside a longer number run is not split", () => {
    expect(r("Card: 4111-1111-1111-1111")).toBe("Card: [NUMBER]");
  });

  it("keeps the original values in the spans for reveals", () => {
    const { spans } = redact("Call +90 532 123 4567 or jane@acme.com", SETTINGS);
    expect(spans.map((s) => [s.kind, s.value])).toEqual([
      ["PHONE", "+90 532 123 4567"],
      ["EMAIL", "jane@acme.com"],
    ]);
  });

  it("skips a detector that is turned off", () => {
    const settings = with_({ detectors: { ...SETTINGS.detectors, phone: false } });
    expect(r("Call +90 532 123 4567", settings)).toBe("Call +90 532 123 4567");
  });

  it("only tries the configured phone regions for numbers without +", () => {
    expect(r("Call 0532 123 45 67", with_({ phone_regions: ["US"] }))).toBe("Call 0532 123 45 67");
  });

  it("runs a custom detector, gated by its context words", () => {
    const settings = with_({
      custom: [{ kind: "MEMBER", pattern: "\\bM-\\d{6}\\b", flags: "i", context: ["membership"], window: 30, score: 0.7 }],
    });
    expect(r("Your membership id is M-123456.", settings)).toBe("Your membership id is [MEMBER].");
    expect(r("Model M-123456 is back in stock.", settings)).toBe("Model M-123456 is back in stock.");
  });

  it("runs a custom detector with a validator", () => {
    const settings = with_({
      custom: [{ kind: "LOYALTY", pattern: "\\b\\d{16}\\b", flags: "", context: [], window: 40, validator: "luhn", score: 0.9 }],
    });
    expect(r("Points card 4111111111111111 and 4111111111111112", settings)).toBe("Points card [LOYALTY] and 4111111111111112");
  });

  it("handles a long realistic email within one pass", () => {
    const text = [
      "Hi Sarah,",
      "Thanks for applying to Acme Corp. Please book a slot at https://cal.acme.com/s/abc123 or call",
      "+31 20 794 0000. Your candidate portal code is 9F3K2L. Our office: 221B Baker Street, London.",
      "Order #4455667788 and the date 2026-10-08 are unrelated.",
    ].join("\n");
    expect(r(text)).toBe(
      [
        "Hi Sarah,",
        "Thanks for applying to Acme Corp. Please book a slot at [LINK] or call",
        "[PHONE]. Your candidate portal code is [CODE]. Our office: [ADDRESS], London.",
        "Order #4455667788 and the date 2026-10-08 are unrelated.",
      ].join("\n"),
    );
  });
});
