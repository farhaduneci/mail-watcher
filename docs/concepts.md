# Concepts

## App config

One YAML file, `mail-watcher.yaml`, defines all behaviour: watches, models, prompts, channels,
redaction, alerts and schedules. `npm run build` merges it over `config/defaults.yaml`, validates
it and bundles it as JSON into the Worker, which carries no YAML parser. A broken config fails the
build, never live mail. Cloudflare resources (bindings, crons, routes) stay in `wrangler.jsonc`.

Secrets never appear in the YAML. Keys ending in `_secret` hold the *name* of a Worker secret
(`token_secret: TELEGRAM_BOT_TOKEN`), and `npm run setup` prompts for each value.

## Watch

A named rule set: a **match**, **categories**, and the special actions `uncertain` and `on_error`.

- **Match**: globs on `to`, `from` and `subject` (`*` any run, `?` one character, case-insensitive).
  Every given field must match. Watches are tried in order; the first match wins. Mail matching no
  watch gets the top-level `default` action and skips Jev.
- **Plus-tags**: `jobs+*@example.com` catches `jobs+acme@example.com`; the tag (`acme`) is stored
  in the ledger, so each place the address was handed out stays traceable.
- **Fields**: names and descriptions (`company: The hiring company`). The writer extracts them and
  the ledger stores them. With `extract: always` this happens for every email, not just notifying ones.

## Category and action

A category is a name plus a plain-language description, which Jev uses as the criteria. Its
action is `forward` (an address, or `inbox`) and/or `notify` (channel instance names). Neither
means **drop**.

- `min_confidence`: below this Jev probability, the watch's `uncertain` action applies instead
  (default: forward to the inbox). Categories that don't forward default to 0.8, so a wrong call
  never silently loses mail.
- `on_error`: used when Jev fails or answers outside the categories. It must forward.
- A forward to an unverified destination falls back to the inbox; the ledger and an alert record it.

Mail that only notifies costs one Jev call and one writer call. Mail that doesn't notify costs only
the Jev call.

## Redactor and detectors

Before any model call, the redactor runs a set of detectors over the from, subject and body.
Each detector finds spans of one kind; overlapping spans merge into one, so no part of a value
survives. The text then reads `Call [PHONE] or visit [LINK]`.

| Kind | Detector |
|---|---|
| `LINK` | URLs, including bare `example.com/x` (linkify-it, fuzzy links on) |
| `EMAIL` | email addresses |
| `PHONE` | libphonenumber-js, valid numbers only; numbers without `+` are tried against `phone_regions` |
| `CODE` | 4–8 character codes near words like code, OTP, verification |
| `NUMBER` | cards (Luhn), IBANs (mod-97), account numbers near words like account |
| `ADDRESS` | street addresses (house number + street suffix, and common European forms) |
| `SECRET` | API keys and tokens (patterns from gitleaks/secretlint), private keys, JWTs, high-entropy strings |

Names and company names stay, so summaries remain useful. Each detector can be turned off, and
custom detectors (regex, kind, optional context words, optional `luhn`/`mod97` validator) cover
data specific to one deployment.

## Reveal

A category can `reveal` chosen kinds, for example `[PHONE]`. The original values are appended to
the note by code. They are never sent to a model and never stored.

## Note

The structured notification handed to a channel:

```json
{
  "text": "Acme wants a 30 minute call next week.",
  "link": { "url": "https://mail.google.com/...#search/rfc822msgid%3A...", "label": "Backend Engineer - next steps" },
  "reveals": { "PHONE": ["+90 532 123 4567"] },
  "tags": ["jobs", "interview"],
  "watch": "jobs",
  "category": "interview",
  "subject": "Backend Engineer - next steps"
}
```

The writer (Workers AI or an OpenAI-compatible endpoint) writes `text` from the redacted email,
guided by `prompts.write` and the watch's `hint`. The link opens the email by its Message-ID
(Cloudflare keeps it when forwarding); without one, it searches the subject. If the writer fails,
`text` falls back to the subject and an alert goes out.

## Channel

A plugin that delivers notes. A **channel instance** is a named, configured use of a channel type
(`phone: { type: telegram, chat_id: ..., token_secret: ... }`), so different watches can notify
different places. Built in: `telegram` and `webhook`. See [channels.md](channels.md).

## Ledger

The D1 table `mail`: one row per email with time, recipient, plus-tag, sender, subject,
Message-ID, watch, category, confidence and all probabilities, action flags (`forwarded`,
`dropped`, `notified`), destination, fields, summary, per-channel results, elapsed ms and errors.
Raw `.eml` files can be kept in R2 for `retain_days` (default 30) to recover from a wrong drop.

## Alerts

Notes about the watcher's own failures, sent to `alerts.channels`. Kinds:

| Kind | Raised when |
|---|---|
| `jev` | Jev fails or answers outside the categories (the mail takes `on_error`) |
| `writer` | the writer model fails (a fallback note goes out) |
| `forward` | a forward fails (the mail falls back to the inbox) |
| `channel` | a channel fails to deliver a note |
| `parse` | an email can't be read or parsed (its `on_error` or `default` action still forwards it) |
| `storage` | the raw email can't be stored in R2 |
| `config` | a secret named in the config isn't set, or a binding the config needs is missing; checked on every use and on the self-test cron |
| `selftest` | the self-test fails |
| `silence` | a watch with `silence_hours` has gone quiet |

At most one alert per kind is
sent per `throttle_minutes` (default 60). Every alert is recorded in D1 with its delivery result,
so a failing alert channel shows up on the dashboard.

## Self-test, silence and digest

- **Self-test** (cron `schedules.selftest`): the canned `selftest` email runs through redact, Jev
  and the writer, and a note is rendered for every channel instance without sending. With
  `expect`, Jev must pick that category. The run is recorded; a failure alerts. The same cron runs
  the **silence** check (`silence_hours` per watch) and deletes raw mail older than `retain_days`.
- **Digest** (cron `schedules.digest`): the writer summarizes per-watch, per-category counts and
  the subjects (redacted) of notable mail over `digest_days`, sent to `digest_channels`.
