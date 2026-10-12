# PII redaction in a Cloudflare Email Worker, before LLM calls

Researched 2026-10-08. Goal: strip sensitive data from email text before it reaches Jev/TypeSafe,
Workers AI or OpenAI-compatible APIs. Typed placeholders: `[LINK] [EMAIL] [PHONE] [CODE] [NUMBER]
[ADDRESS] [SECRET]`. Person and company names stay. Must run in-isolate (no third-party redaction
call), stay small, be configurable and extensible.

## Verdict

Build a small in-house recognizer pipeline in TS, shaped like Presidio (recognizers return scored
spans, one conflict-resolution pass, one replace pass). Use libraries only where they beat
hand-written regex:

- **Phones:** `libphonenumber-js/max` `findPhoneNumbersInText` (≈57 KB gz).
- **Links:** `linkify-it` with `fuzzyLink: true` (≈4.5 KB gz).
- **Secrets:** regexes ported from gitleaks / secretlint (MIT), stored in a data file. Don't pull in
  the libraries themselves.
- **Email, card (Luhn), IBAN (mod-97), OTP codes (context words), addresses (context + street
  suffix):** in-house recognizers, with patterns kept in a data file and loaded by the code.

No off-the-shelf JS library fits as-is. Each one fails on Worker compatibility, detector coverage,
or accuracy (tests below).

## Candidates

| Tool | Version / last release | License | Runtime fit | Bundle (min+gz, esbuild) | Coverage vs needs | Extensibility | Notes |
|---|---|---|---|---|---|---|---|
| libphonenumber-js | 1.13.15, 2026-10-08 | MIT | pure JS, no deps, `sideEffects:false` | `/min` ≈36 KB, `/max` ≈57 KB | phones only, international + national | `defaultCountry`, `leniency` (`POSSIBLE`/`VALID`/…) | port of Google `PhoneNumberMatcher.java`; 32M dl/wk |
| linkify-it | 6.1.0, 2026-07-22 | MIT | pure JS | ≈4.5 KB | URLs, fuzzy emails | `.add()` custom schemas, `.tlds()` | **v6: `fuzzyLink` defaults to false**, so bare `example.com` is missed unless enabled |
| @redactpii/node | 1.0.19, 2026-09-28 | MIT | zero deps, ≈2 KB gz | ≈2 KB | email, US phone, card, SSN, names after greeting | on/off `rules`, `customRules` (regex only, all → one label) | **no international phones, no addresses**; optional `apiKey` posts events to `api.redactpii.com` (off by default) |
| openredaction (@openredaction/core) | 1.1.5, 2026-07-26 | MIT | **main entry imports `fs`, `worker_threads`, `node:os`**; `/lite` still imports `node:module` (`createRequire`) and esbuild can't bundle it for the browser | n/a (core chunk 311 KB raw) | 570+ patterns claimed | `customPatterns` with priority/placeholder, whitelist, presets | Node test failed badly (below) |
| @arcjet/redact | 1.14.1, 2026-10-07 | Apache-2.0 | WASM, has a `workerd` export condition | ≈114 KB | email, phone, card, IP only | custom `detect(tokens)` + `replace` hooks; token-based, no regex | labelled an IBAN as a phone number in testing |
| redact-pii (solvvy) | 3.4.0, 2022-07-29 | MIT | depends on `@google-cloud/dlp` and lodash | — | — | — | stale; excluded |
| pii-filter | 1.0.24, 2021-03-03 | MIT | 17 MB unpacked | — | — | — | abandoned; excluded |
| @siddicky/anonymizerts | 1.0.3, 2026-02-19 | MIT | depends on `@huggingface/transformers` (NER model) | — | Presidio-style TS port | recognizers | heavy ML dependency, not Worker-friendly; worth reading as a TS reference |
| Presidio (Microsoft) | analyzer 2.2.364 | MIT | Python + spaCy; excluded | — | — | `PatternRecognizer` (regex + score + context words + `validate_result`), registry, anonymizer operators | the design to copy |
| gitleaks rules | `config/gitleaks.toml`, 222 rules, repo pushed 2026-09-30 | MIT | data only | — | API keys, tokens | — | Go RE2 syntax: convert inline `(?i)` and check each pattern before use |
| secretlint preset-recommend | 13.0.7, 2026-10-03 | MIT | rules are code (`context.report`); core pulls `debug`, `structured-source` | — | ~30 providers (AWS, GCP, GitHub, OpenAI, Anthropic, Slack, Stripe, private keys, DB URLs…) | — | copy the regexes, don't import the package |

Sources: npm registry (`registry.npmjs.org/<pkg>`) for versions, dates, licenses and deps;
[libphonenumber-js README](https://gitlab.com/catamphetamine/libphonenumber-js) (findPhoneNumbersInText,
metadata: min ≈80 KB, max ≈145 KB, mobile ≈95 KB raw JSON); `source/PhoneNumberMatcher.js` (leniency default `VALID`);
[linkify-it README](https://github.com/markdown-it/linkify-it) ("fuzzyLink … Default `false`");
[@redactpii/node README](https://github.com/wrannaman/redactpii-node) (FAQ: no international phones, no addresses);
[openredaction README](https://github.com/sam247/openredaction); [@arcjet/redact README](https://github.com/arcjet/arcjet-js/tree/main/redact);
[gitleaks.toml](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml);
[secretlint preset](https://github.com/secretlint/secretlint/tree/master/packages/%40secretlint/secretlint-rule-preset-recommend);
[Presidio anonymizer](https://data-privacy-stack.github.io/presidio/anonymizer/), [adding recognizers](https://data-privacy-stack.github.io/presidio/analyzer/adding_recognizers/).
Bundle sizes come from local esbuild runs (`--bundle --minify --platform=browser`).

## Smoke test (Node, 2026-10-08)

Input contained a Turkish national phone `0532 123 45 67`, `+90 532 123 4567`, `order #123456789`,
`2026-10-08`, `your code is 482913`, `example.com/x?a=1`, a test Visa, an email, a TR IBAN,
`221B Baker Street, London NW1 6XE`, and an `sk-proj-…` key.

- **libphonenumber-js** (`defaultCountry:'TR'`): caught both phones, and didn't flag the order number, the
  date or the OTP. With `US` or no default country it only caught the `+90` number, so national
  numbers need the right `defaultCountry`.
- **openredaction** (placeholder mode): missed the email and both phones, flagged the OTP as a
  `DELAWARE_LICENSE_PLATE`, redacted "Hi Sarah Jones from" and "Baker Street" as names, and broke the
  API key into `sk-proj-abcdEFGH[ORDER_4088]0…`, leaking most of it.
- **@redactpii/node**: missed the national phone, caught `+90 532 123 4567` only partly (`+90
  PHONE_NUMBER`), labelled part of the IBAN as a card number, and didn't touch the key or the address.
- **@arcjet/redact**: handled phones, card and email, but labelled the IBAN tail as a phone and
  missed the URL, OTP and key.

## Cloudflare-native options

| Feature | What it does | Redacts? | Cost / plan | Applies to Workers AI? |
|---|---|---|---|---|
| AI Gateway DLP | scans prompts and responses through the gateway with Cloudflare DLP profiles | **No.** Pass, Flag (`cf-aig-dlp` header + logs) or Block (400) | free on all plans; without Zero Trust DLP, only the Financial Information and Social/Insurance/National ID profiles | DLP applies to "all AI providers supported by AI Gateway"; Workers AI calls go through the gateway via `env.AI.run(..., { gateway: { id } })` |
| AI Gateway Guardrails | content safety via `@cf/meta/llama-guard-3-8b` | No (flag or block) | billed as Workers AI tokens | yes, but it covers harm categories, not PII |
| WAF Firewall for AI | PII detection on **incoming** JSON requests to `cf-llm`-labelled endpoints | No (WAF fields → block, challenge or log) | Enterprise paid add-on | inbound zone traffic only; not for outbound Worker calls |
| Workers AI models | catalogue has no PII, NER or token-classification model; only llama-guard for safety | — | — | — |

Sources: [AI Gateway DLP](https://developers.cloudflare.com/ai-gateway/features/dlp/),
[AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/),
[Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/),
[Workers AI binding via gateway](https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/),
[Firewall for AI](https://developers.cloudflare.com/waf/detections/firewall-for-ai/),
[Workers AI models](https://developers.cloudflare.com/workers-ai/models/).

Conclusion: AI Gateway DLP is a cheap backstop for **blocking** leaked financial or national-ID data.
It can't replace in-Worker redaction.

## Workers limits (correction to the brief)

The [limits page](https://developers.cloudflare.com/workers/platform/limits/) now says Worker size
is 64 MiB uncompressed on both Free and Paid: "There is no compressed size limit." The real
constraints are a **1 s startup** (global scope), **10 ms CPU per request on Free** (5 min max on
Paid) and 128 MB memory. Email Workers count CPU the same way, so regex cost matters more than bundle size.
Build heavy objects (the LinkifyIt instance, compiled regexes) lazily or cheaply at module scope.

## Proposed design (Presidio-shaped, ~300 LOC)

```
Recognizer { id, entity, placeholder, enabled, priority,
             find(text): Span[] }            // Span {start,end,entity,score}
PatternRecognizer  (regex[] + score + contextWords[] + validate?(match) → bool)
FnRecognizer       (wraps libphonenumber-js / linkify-it)
```

1. **Normalize:** HTML → text first, decode entities (`&#64;`, `&amp;`), normalize NBSP and zero-width
   characters, and keep an offset map if spans have to point back to the original.
2. **Run** every enabled recognizer over the same normalized string. Detectors never see each other's output.
3. **Resolve overlaps** (Presidio rules): same span → higher score wins, then priority; one span
   inside another → keep the longer; partial overlap → merge into the union and take the
   label of the higher-priority entity. Secrets beat everything.
4. **Replace** right-to-left in one pass. Optionally collapse runs of identical placeholders.
5. **Config** lives in a JSON/YAML file (no in-code templates): per-detector on/off, placeholder
   text, phone `defaultCountry` list (try each, e.g. `TR`, `NL`, `DE`, `GB`, `US`), custom
   `{regex, placeholder, validator?}` entries, and an allow-list.

| Placeholder | Recognizer |
|---|---|
| `[SECRET]` | gitleaks/secretlint-derived regexes (sk-, ghp_, xox[bp]-, AKIA, `-----BEGIN … PRIVATE KEY`, JWT `eyJ…\.eyJ…`), plus a long-token rule: high-entropy run of ≥32 `[A-Za-z0-9_\-]` |
| `[LINK]` | linkify-it (`fuzzyLink:true`, `fuzzyEmail:false`), plus tracking-link hosts |
| `[EMAIL]` | RFC-lite regex (runs before LINK; linkify can also return `mailto:`) |
| `[PHONE]` | `findPhoneNumbersInText(text, {defaultCountry, leniency:'VALID'})` with `/max` metadata, once per configured country, results merged |
| `[NUMBER]` | card: 13–19 digits with separators + **Luhn**; IBAN: country prefix + **mod-97**; account numbers only with context words ("account", "hesap", "IBAN", "Konto") |
| `[CODE]` | 4–8 digit or alphanumeric token **within N chars of context words** ("code", "OTP", "verification", "doğrulama", "kod", "PIN"); a bare 6-digit number alone isn't enough |
| `[ADDRESS]` | context-driven: house number + street suffix list (Street/St/Ave/Road/Cad./Sok./Mah./straße/laan) and/or postcode pattern near a city name. Expect recall below 100% (no NER) |

## Pitfalls

- **Order and overlap:** run all detectors on the original text, then resolve once. Running them in sequence on
  already-redacted text breaks placeholders (openredaction leaked most of an API key this way). Run secrets
  and URLs before digit detectors, because tokens and URLs contain digit runs.
- **False positives:** dates (`2026-10-08`, `08.10.2026`), times, prices, order, invoice and tracking
  numbers, years and zip codes look like phones, codes or account numbers. Use validators (Luhn, mod-97,
  libphonenumber `VALID`) and context words, and keep a negative-context list ("order", "invoice",
  "ref", "#").
- **Phones without `+`:** national formats only match with the right `defaultCountry`, so try
  several countries and keep validated hits only. `leniency:'POSSIBLE'` catches more but also
  flags long order numbers.
- **HTML emails:** decode entities and strip tags before detection. `href` values are URLs too.
  Quoted-printable soft line breaks (`=\n`) split tokens, so decode MIME first (e.g. postal-mime).
- **URLs carry PII:** tokens in query strings, unsubscribe links, magic-login links. Redact the
  whole URL, or keep just the host if the LLM needs the domain.
- **Names stay** by design, so don't enable name detectors from libraries (redactpii and openredaction
  both redact names by default).
- **ReDoS / CPU:** 10 ms CPU on Free. Use linear-safe patterns, cap the input length, and don't use
  nested quantifiers in custom regexes. gitleaks patterns are RE2 (linear); in V8 they backtrack.
- **Go → JS regex:** gitleaks uses `(?i)` inline flags. Rewrite them as flags or char classes, and test each ported rule.
- **Placeholders must not match detectors** (e.g. `[CODE]` mustn't trip anything). Use bracketed
  uppercase forms and keep the replace pass last.
