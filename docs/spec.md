# mail-watcher — spec v1

Status: ready for implementation. Successor to `job-mail-worker`, which it replaces once v1 is proven.

## Problem Statement

An owner of a custom domain gives out addresses (e.g. `jobs@`, `hi@`) on job applications, web forms
and sign-ups. The mail that matters on those addresses is rare and gets buried under auto-replies,
confirmations and noise. The predecessor, `job-mail-worker`, solved this for one use case only:

- Categories, destinations and logic are hardcoded for job applications. Watching a second address
  for a different kind of event means changing code.
- Phone notifications come from fixed message templates, so they read the same every time and say
  little about what the email actually contains.
- A notification names the email ("Check your inbox for 'Reminder: Your Upcoming Interview'")
  instead of linking to it, so finding it takes a manual search.
- Full email text, including links, phone numbers, codes and account numbers, is sent to model
  providers, though the models only need the gist.
- Configuration is spread over Worker variables, secrets, content files and code, so self-hosting
  and changing behaviour are both hard.
- A fallback classifier hides provider failures instead of surfacing them, and nothing tells the
  owner when the worker is up but no longer doing its job.

## Solution

A general-purpose, self-hostable Cloudflare Email Worker that watches any number of addresses. Each
**watch** is defined in a single YAML app config: which mail it matches, the categories that mail can
fall into (described in plain language), and what happens to each category: **forward** it, **drop**
it, and/or **notify** the owner. Every email lands in a **ledger**.

Before any model sees an email, a **redactor** replaces sensitive values with typed placeholders
(`[LINK]`, `[PHONE]`, `[CODE]`, ...). Jev classifies the email. For notifying categories, a
configurable LLM writes a short, specific summary. The code then attaches a link that opens the
exact email in the mailbox, plus any **reveals** the category opts into, and sends the **note** to
one or more pluggable **channels**.

Failures are loud: any failure alerts the owner, mail that cannot be classified still reaches the
inbox, and a daily **self-test** proves the pipeline works end to end. A read-only black-and-white
dashboard shows the ledger, stats and effective config.

## Glossary

- **App config**: the single YAML file defining all behaviour (watches, models, prompts, channels,
  redaction, alerts, schedules). Cloudflare resources (bindings, crons, routes) stay in
  `wrangler.jsonc`.
- **Watch**: a named rule set: a `match`, categories, and the special actions `uncertain` and
  `on_error`.
- **Match**: globs on `to`, `from`, `subject`. Watches are ordered; the first match wins. Mail
  matching no watch gets the `default` action.
- **Category**: a user-defined name plus a plain-language description that Jev uses as criteria.
- **Action**: `forward` (an address) and/or `notify` (channel names). Neither means **drop**.
- **Redactor / detector**: the redactor runs a set of detectors over the text. Each detector finds
  spans of one kind and assigns a placeholder.
- **Reveal**: the original values of chosen placeholder kinds, appended to a note by code. Never
  sent to a model and never stored.
- **Note**: the structured notification handed to a channel.
- **Channel**: a plugin that delivers notes (Telegram, webhook, ...). A channel instance is a named
  configured use of a channel type.
- **Ledger**: the D1 table with one row per email.
- **Alert**: a note about the watcher's own failures.
- **Self-test**: a scheduled synthetic run of the whole pipeline.
- **Digest**: a scheduled, LLM-written summary of ledger activity.

## User Stories

### Watching and routing

1. As an owner, I want to define several watches in one file, so that each address I hand out gets its own rules.
2. As an owner, I want a watch to match by recipient glob (e.g. `jobs+*@domain`), so that plus-tagged addresses share one watch.
3. As an owner, I want to also match by sender and subject, so that I can carve out special cases within one address.
4. As an owner, I want watches evaluated in order with the first match winning, so that rules are predictable.
5. As an owner, I want a `default` action for mail matching no watch, so that nothing routed to the worker is silently lost.
6. As an owner, I want to define my own categories with plain-language descriptions, so that classification fits my use case without code changes.
7. As an owner, I want each category to forward, notify, both, or neither (drop), so that I control what reaches my mailbox and my phone.
8. As an owner, I want notify-only categories, so that some mail only pings me without cluttering the mailbox.
9. As an owner, I want each category to set `min_confidence`, so that uncertain classifications take the safe path.
10. As an owner, I want the `uncertain` action (default: forward to the main inbox) for low-confidence mail, so that a doubtful call never hides an important email.
11. As an owner, I want a drop to require a minimum confidence (default 0.8), so that a wrong drop doesn't destroy mail.
12. As an owner, I want unverified forward destinations to fall back to the main inbox and be logged, so that a setup mistake costs clutter, not mail.
13. As an owner, I want the plus-tag of the recipient recorded, so that replies tie back to where I used the address.

### Privacy

14. As an owner, I want URLs, emails, phones, verification codes, card/IBAN/account numbers, street addresses and secrets replaced with typed placeholders before any model call, so that providers get the gist and not my data.
15. As an owner, I want names and company names left intact, so that summaries stay useful.
16. As an owner, I want to toggle each detector in the config, so that I can trade privacy for context per deployment.
17. As an owner, I want to add custom detectors (regex, placeholder, optional context words, optional validator), so that I can cover data specific to me.
18. As an owner, I want phone detection to work without a `+` prefix, using a default region list (including IR and TR) that I can change, so that local numbers are caught.
19. As an owner, I want card numbers checked with Luhn and IBANs with mod-97, so that order numbers and dates aren't redacted by mistake.
20. As an owner, I want codes and addresses only redacted near context words, so that ordinary numbers survive.
21. As an owner, I want a category to reveal chosen placeholder kinds (e.g. `PHONE`) in the note, so that I see the real value on my phone while the model never does.
22. As an owner, I want revealed values never stored in the ledger, so that the database holds no sensitive values.

### Notifications

23. As an owner, I want an LLM to write each note from the redacted email, so that notes are specific and read naturally.
24. As an owner, I want the writer prompt and per-watch hints in the app config, so that I can tune the tone and content without code.
25. As an owner, I want to change the writer model (any Workers AI model or an OpenAI-compatible endpoint), so that I can pick cost and quality.
26. As an owner, I want each note to link to the exact email in my mailbox (Message-ID search, subject as link text), so that one tap opens it.
27. As an owner, I want the mailbox link template configurable, with a subject search as fallback when there's no Message-ID, so that non-Gmail mailboxes and multiple Gmail accounts work.
28. As an owner, I want notes tagged `#<watch> #<category>`, so that I can search them in the chat.
29. As an owner, I want a note to fall back to subject + link + tags when the writer fails, so that I still hear about the email.
30. As an owner, I want a watch to declare fields to extract (e.g. company, role), returned by the writer call and stored in the ledger, so that downstream tools can use them.
31. As an owner, I want field extraction on every mail as an opt-in (`extract: always`), so that non-notifying mail can carry fields too.
32. As an owner, I want non-notifying mail to cost only the Jev call, so that running costs stay low.

### Channels

33. As an owner, I want several named channel instances, so that different watches notify different places.
34. As an owner, I want Telegram and webhook channels built in, so that common setups work out of the box.
35. As a contributor, I want to add a channel by dropping one TypeScript file into the channels folder, so that new channels need no wiring.
36. As a contributor, I want a channel to declare its own config schema, so that config errors are caught at build time.
37. As a contributor, I want channels to receive a structured note and render it themselves, so that each channel uses its native format.
38. As an owner, I want channel secrets referenced by secret name in the config, so that no secret lives in the YAML.

### Reliability and alerts

39. As an owner, I want Jev as the only classifier with no silent fallback, so that the behaviour is simple and failures are visible.
40. As an owner, I want mail Jev can't classify to get the watch's `on_error` action (default: forward to the main inbox, never drop), so that a provider outage never loses mail.
41. As an owner, I want an alert on Telegram (alert channels) whenever Jev, the writer, a forward or a channel fails, so that I know the worker is up but broken.
42. As an owner, I want alerts throttled to one per error kind per hour, so that an outage doesn't flood my phone.
43. As an owner, I want a daily self-test that runs a canned email through redact, Jev, the writer and a dry channel render, so that silent breakage is caught even with no traffic.
44. As an owner, I want an optional `silence_hours` per watch, so that I'm alerted when an address that should get mail goes quiet.
45. As an owner, I want alert-channel failures recorded and shown on the dashboard, so that the last line of defence is visible too.
46. As an owner, I want config errors to fail the build instead of live mail, so that a typo never drops email.

### Digest

47. As an owner, I want a scheduled digest written by the LLM from per-watch and per-category counts and notable subjects, so that I get a readable weekly picture.
48. As an owner, I want the digest schedule, prompt and channels in the config, so that I can change them without code.

### Ledger and dashboard

49. As an owner, I want every email logged (time, to, from, subject, Message-ID, plus-tag, watch, category, probabilities, action taken, fields, summary, CPU ms, error), so that I can audit every decision.
50. As an owner, I want raw emails optionally kept in R2 for `retain_days` (default 30, 0 = off), so that a wrong drop can be recovered.
51. As an owner, I want a read-only dashboard on my own domain behind Cloudflare Access, so that I can see the ledger, stats and effective config privately.
52. As an owner, I want the dashboard to show stats per watch and category over time, so that I can see what the watcher is doing.
53. As an owner, I want the effective config shown with secrets masked, so that I can check what is deployed.
54. As an owner, I want recent alerts and self-test results on the dashboard, so that health is visible at a glance.
55. As an owner, I want a minimal black-and-white design, so that the dashboard is quick to read.
56. As an owner, I want to open a ledger row's email in my mailbox and download the retained raw email, so that I can recover from mistakes.

### Hosting

57. As a self-hoster, I want one YAML app config plus a standard `wrangler.jsonc`, so that setup is understandable.
58. As a self-hoster, I want a fully commented example config and a JSON Schema, so that my editor autocompletes and validates.
59. As a self-hoster, I want `npm run setup` to create D1 (and R2), prompt for each secret named in the config, create Email Routing rules for each watch's addresses and register forward destinations for verification, so that first-time setup is one command.
60. As a self-hoster, I want `npm run deploy` to validate the config, bundle it, apply migrations and deploy, so that changes ship in one command.
61. As a self-hoster, I want the build to fail when a scheduled job in the YAML has no matching cron in `wrangler.jsonc`, so that schedules don't silently never run.
62. As a self-hoster, I want docs covering concepts, every config key, writing a channel and deployment, so that the many terms are explained.
63. As a self-hoster, I want my private config gitignored in the repo, so that my addresses never get committed.
64. As a self-hoster, I want to stay within Cloudflare's free tier for personal volume, so that running it costs nothing beyond the LLM and Jev.

## Implementation Decisions

### Platform and layout
- Cloudflare Worker in TypeScript with D1 (ledger), optional R2 (raw retention), Workers AI binding, an `email` handler, a `scheduled` handler, and a `fetch` handler (dashboard).
- New standalone repository, MIT, public. Private app config (`mail-watcher.yaml`) and private `wrangler.jsonc` values live in the repo folder, gitignored, next to `mail-watcher.example.yaml`.

### App config
- YAML. A prebuild step parses it, validates it with a zod schema, and emits bundled JSON. The runtime carries no YAML parser. The same zod schema generates the editor JSON Schema and the config reference doc, so docs can't drift.
- All prompts (classification instructions, writer, digest, self-test sample) live in the YAML. No prompt or message template lives in code.
- Top-level shape (decided keys; exact nesting may be refined in implementation):
  - `mailbox`: main inbox address, link template (default Gmail `#search/rfc822msgid:{message_id}` with an `authuser` setting), subject-search fallback template.
  - `models`: `classify` (Jev: url, model name, secret name); `write` (provider `workers-ai` | `openai-compatible`, model, base URL, key secret name).
  - `prompts`: classify instructions, writer, digest.
  - `redact`: detectors on/off, `phone_regions` (default list includes IR, TR, DE, GB, US, NL and other common regions), custom detectors, body cap.
  - `channels`: named instances `{ type, ...type settings, secret names }`.
  - `watches[]`: `name`, `match {to, from, subject}`, `hint` (writer guidance), `fields` (names + descriptions), `extract` (`notify` | `always`), `categories {name: {description, forward?, notify?, min_confidence?, reveal?}}`, `uncertain`, `on_error`, `silence_hours?`.
  - `default`: action for unmatched mail.
  - `alerts`: channels, throttle window.
  - `schedules`: `digest`, `selftest` cron strings, plus digest channels.
  - `retain_days`.
- Validation rules: a drop needs `min_confidence` (default 0.8 applied); `on_error` can't drop; every referenced channel exists; every channel's settings pass its own schema; every schedule cron appears in `wrangler.jsonc`.

### Pipeline (per email)
1. Parse MIME (postal-mime), decode HTML and entities, drop quoted replies, cap the body (~20 KB).
2. Select the watch (ordered globs).
3. Redact (below).
4. Classify with Jev: one choice question, the watch's categories as criteria, the redacted from/subject/body as state. Below the category's `min_confidence` → `uncertain`. Jev error → `on_error` + alert.
5. Act: forward (unverified destination → main inbox + logged), or drop.
6. Notify (when the category notifies): writer call returns JSON `{message, fields}` → build the note → send to each channel. Writer error → fallback note + alert.
7. Write the ledger row; optionally store the raw `.eml` in R2.
- Forwarding happens before notify and logging. Notify, ledger and R2 run in `waitUntil`.

### Redactor (research: `docs/research/pii-redaction-workers.md`)
- In-house, modelled on Presidio's recognizer/anonymizer split. Each detector returns scored spans `{start, end, kind, score}` from the original text. Overlaps are settled once (higher score wins, then the longer span). Replacement runs right to left. Detectors never run on already-redacted text.
- Built-in detectors:
  - LINK: linkify-it with fuzzy links on.
  - EMAIL.
  - PHONE: libphonenumber-js `findPhoneNumbersInText` across `phone_regions`, valid hits only.
  - CODE: digit/alnum runs near words like code/OTP/verification.
  - NUMBER: cards with Luhn, IBANs with mod-97, long account numbers.
  - ADDRESS: context-gated.
  - SECRET: a data file of regexes adapted from gitleaks/secretlint (MIT), converted from Go to JS syntax.
- Custom detectors come from config: regex, placeholder kind, optional context words, optional validator (`luhn`, `mod97`).
- Interface: `redact(text, settings) → { text, spans }`. The spans keep original values in memory only, so reveals work.

### Notes and the mailbox link
- Note shape: `{ text, link: {url, label}, reveals: {kind: values[]}, tags, watch, category, subject }`.
- Link: Message-ID search URL from the template; falls back to a subject search URL.
- Code (not the LLM) adds the link, reveals and tags. If the writer fails, the text falls back to the subject.

### Channels
- One file per type in the channels folder, exporting `{ type, settingsSchema, send(note, settings, env) }`. A prebuild step scans the folder and generates the registry.
- Built in: `telegram` (HTML parse mode, link as an anchor), `webhook` (POST JSON note).

### Alerts and self-test
- Alert kinds: `jev`, `writer`, `forward`, `channel`, `config`, `selftest`, `silence`. Throttle: one per kind per window (default 1 h), with state in D1.
- Self-test (cron): the canned sample from config → redact → Jev → writer → render a note for each channel type without sending. Pass/fail is recorded. A failure sends an alert.
- Silence check runs with the self-test cron.
- If the alert channel fails, it is recorded in D1 and shown on the dashboard.

### Ledger schema (D1)
- `mail`:
  - `id`, `at`, `to_addr`, `tag`, `from_addr`, `subject`, `message_id`, `watch`, `category`
  - `confidence`, `probs` (JSON), `action` (forwarded/dropped/notified flags), `forwarded_to`
  - `fields` (JSON), `summary`, `notified` (channel results JSON), `cpu_ms`, `error`, `r2_key`
- `alerts`: `id`, `at`, `kind`, `detail`, `sent`.
- `runs`: `id`, `at`, `job` (selftest/digest), `ok`, `detail`.

### Dashboard
- Served by the same Worker's `fetch` handler on a custom domain route. Access is protected by Cloudflare Access, configured by the self-hoster and documented.
- Read-only, minimal black-and-white HTML. Views: ledger (filter by watch/category/action, mailbox link, raw download when retained), stats (per watch/category over time), health (alerts, self-test runs), config (effective, secrets masked).

### Scripts
- `setup`: create D1/R2, apply migrations, `wrangler secret put` for each secret named in config, create Email Routing rules (Cloudflare API with the wrangler login) for each watch's literal `to` addresses, register forward destinations.
- `deploy`: validate config → generate registry and bundled JSON → migrate → deploy.

### Docs
- README (what it is, quickstart), concepts (glossary), config reference (generated), channels guide, deploy guide, a fully commented example YAML.
- Written in third person, with no personal data.

### Rollout
- The owner's private config gets a `jobs` watch reproducing the predecessor's categories:
  - offer, interview, assessment, action → forward to the attention address + notify
  - verification → forward to inbox
  - confirmation, noise → forward to the ack address, min 0.8
  - rejection → forward to the rejected address, min 0.8
  - fields: company, role
- Shadow phase: the new worker handles a test plus-address. Then the domain's `jobs@` routing rule moves from `job-mail-worker` to `mail-watcher`. The old worker stays deployed and unrouted until the owner retires it.

## Testing Decisions

- Good tests drive public entry points with realistic inputs and assert on observable effects: forwards, drops, channel calls, ledger rows and alerts. They never assert on internals.
- **Seam 1 (main):** the Worker's handlers (`email`, `scheduled`, `fetch`) in the Workers vitest pool, with a fixture config, a fake `ForwardableEmailMessage`, and stubbed `fetch` (Jev, OpenAI-compatible, Telegram, webhook) and AI binding. This covers routing, actions, thresholds, `on_error`, fallbacks, notes, links, reveals, alerts, throttling, self-test, silence, digest and dashboard responses.
- **Seam 2:** `redact()` as a pure function, table-driven over fixture texts (international phones with and without `+`, dates and order numbers that must survive, Luhn/mod-97 edge cases, overlapping spans, HTML entities, tokens inside URLs, custom detectors).
- **Seam 3:** config validation (build-time), checking that bad configs are rejected with readable errors and good ones produce the expected bundle.
- Prior art: the predecessor's `test/worker.test.ts` and `test/helpers.ts` (`eml()`, `fakeMessage`, `stubFetch`, `jevAnswer`), which drive the email handler end to end in the Workers pool. Carry that style over.
- Tests are written first, slice by slice:
  1. config
  2. redactor
  3. classify + actions + ledger
  4. writer + channels + link
  5. alerts + self-test
  6. digest
  7. dashboard
  8. scripts

## Out of Scope

- Any fallback classifier (Workers AI or other) for categorization.
- Editing config from the dashboard; the dashboard is read-only.
- Cloudflare AI Gateway DLP as a backstop (possible later).
- Replying to or sending mail.
- Inbound attachments analysis (filenames only, if anything).
- Tracker sync for the owner's job search (`sync.py` in the owner's private repo reads the predecessor's D1). That integration is the owner's follow-up outside this repo, e.g. a webhook channel or reading the new ledger.
- Channels beyond Telegram and webhook.
- Per-watch separate digests.

## Further Notes

- Free-plan CPU budget is 10 ms per invocation. Capping the body and recording `cpu_ms` per row makes this visible; Workers Paid is the documented escape hatch.
- Cloudflare preserves the original Message-ID when forwarding, which the mailbox link relies on.
- Redaction research: linkify-it needs fuzzy links explicitly on (off by default in v6). openredaction does not bundle for Workers. @arcjet/redact is too narrow. libphonenumber-js `max` metadata is about 57 KB gzipped.
