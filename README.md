# MailSentry

A self-hostable Cloudflare Email Worker that watches any number of addresses on a custom domain.
Mail that matters is forwarded and announced on the phone; auto-replies, confirmations and noise
are sorted away or dropped. All behaviour lives in one YAML file.

For each email:

1. The first **watch** whose `match` fits (recipient, sender, subject globs) takes it.
2. A **redactor** replaces links, emails, phone numbers, codes, card/IBAN/account numbers,
   street addresses and secrets with placeholders like `[PHONE]`. Models only ever see that text.
3. [Jev](https://typesafe.ai) picks one of the watch's **categories**, described in plain language,
   with a probability for each.
4. The category's **action** runs: forward to an address, drop, and/or notify. Doubtful calls take
   the safe `uncertain` path; when Jev fails, `on_error` forwards the mail and an alert goes out.
5. For notifying categories, an LLM writes a short note from the redacted text. Code adds a link
   that opens the exact email in the mailbox, any revealed values (e.g. the real phone number),
   and `#watch #category` tags, and sends it to Telegram, a webhook, or any added channel.
6. Every email lands in a D1 **ledger**; the raw `.eml` can be kept in R2 for recovery.

A daily **self-test** runs a canned email through the whole pipeline, a **silence** check notices
watches that went quiet, and a weekly **digest** summarizes activity. A read-only, black-and-white
dashboard behind Cloudflare Access shows the ledger, stats, health and effective config.

## Quickstart

Requirements: a domain on Cloudflare with Email Routing enabled, a [TypeSafe](https://typesafe.ai)
API key for Jev, and Node 22+.

```bash
npm install
cp mailsentry.example.yaml mailsentry.yaml   # gitignored: addresses, watches, channels
cp wrangler.example.jsonc wrangler.jsonc         # gitignored: worker name, domain, crons
npx wrangler login
npm run setup    # D1, R2, migrations, secrets, Email Routing rules, forward destinations
npm run deploy   # validate config → bundle → migrate → deploy
```

`npm run setup` is safe to re-run. It never takes over an address that is already routed to
another worker; it prints what to switch by hand instead.

## Docs

- [Concepts](docs/concepts.md): watches, categories, actions, redaction, notes, alerts.
- [Config reference](docs/config-reference.md): every key, generated from the schema.
- [Channels](docs/channels.md): the built-in channels and how to write a new one.
- [Deploy](docs/deploy.md): setup, Cloudflare Access for the dashboard, free-tier limits, rollout.
- [`mailsentry.example.yaml`](mailsentry.example.yaml): a fully commented config.

Editors that support `# yaml-language-server: $schema=` comments validate and autocomplete
`mailsentry.yaml` against `mailsentry.schema.json`.

## Development

```bash
npm test            # Workers-pool tests (handlers, redactor) and Node tests (config, scripts)
npm run typecheck
npm run build -- --config mailsentry.example.yaml --wrangler wrangler.example.jsonc
```

Tests drive the Worker's `email`, `scheduled` and `fetch` handlers with a fixture config
(`test/fixtures/config.yaml`), a fake inbound message and stubbed `fetch`/AI, and assert on
forwards, channel calls, ledger rows and alerts.

## License

MIT. Secret-detection patterns in `src/redact/secrets.json` are adapted from
[gitleaks](https://github.com/gitleaks/gitleaks) and [secretlint](https://github.com/secretlint/secretlint), both MIT.
