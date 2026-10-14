# Deploy

## Requirements

- A domain on Cloudflare with **Email Routing** enabled (Email → Email Routing).
- A TypeSafe API key for Jev.
- For the default writer, Workers AI (on the account by default). Or any OpenAI-compatible endpoint.
- Node 22+ and `npx wrangler login`.

## First setup

```bash
cp mail-watcher.example.yaml mail-watcher.yaml
cp wrangler.example.jsonc wrangler.jsonc
npm install
npm run setup
npm run deploy
```

`mail-watcher.yaml` and `wrangler.jsonc` are gitignored, so addresses and ids never get committed.

`npm run setup` (idempotent):

1. Validates the config.
2. Creates the D1 database (and writes its `database_id` into `wrangler.jsonc`) and, when
   `retain_days > 0` and an `RAW` R2 binding exists, the bucket.
3. Applies the D1 migrations.
4. Prompts for every secret named in the config (empty keeps the current value).
5. Creates an Email Routing rule to the worker for each watch's literal `to` address. A plus-tag
   glob like `jobs+*@example.com` becomes a rule for `jobs@example.com` (Cloudflare delivers
   subaddresses to the base rule). Other globs are listed for manual rules or a catch-all.
   An address already routed elsewhere is left alone and reported.
6. Registers every forward destination. Cloudflare emails each new one a verification link; until
   it is clicked, forwards there fall back to the inbox and alert.

`npm run deploy` validates and bundles the config, applies migrations and deploys. Every cron
under `schedules` must be in `wrangler.jsonc` `triggers.crons`, or the build fails.

## The dashboard and Cloudflare Access

The dashboard is served by the same Worker on the custom domain in `wrangler.jsonc` `routes`. It
is off until `dashboard.access` is configured:

1. Zero Trust → Access → Applications → Add a self-hosted application for the dashboard hostname,
   with a policy allowing only the owner.
2. Copy the application's **Audience (AUD) tag** and the team domain
   (`<team>.cloudflareaccess.com`) into the config:

   ```yaml
   dashboard:
     access:
       team_domain: myteam.cloudflareaccess.com
       aud: <AUD tag>
   ```

The Worker verifies the `Cf-Access-Jwt-Assertion` token on every request (signature, audience,
issuer, expiry), so a request that bypasses Access is refused. `dashboard.unprotected: true` turns
the check off; use it only for `wrangler dev`.

## Free tier

Personal volume fits Cloudflare's free tier: D1, R2 and Workers AI free allowances, plus the Jev
and writer calls. The Workers free plan allows 10 ms of CPU per invocation. The body cap
(`redact.body_cap`, default 20 000 characters) bounds the redactor's work. The redactor takes about 1–2 ms on ordinary mail; text packed with
phone-like digit runs costs more (each run is checked against every `phone_regions` entry), so
fewer regions or a smaller cap help there. CPU time per invocation is in Workers Logs
(`observability` in `wrangler.jsonc`); waiting on Jev and the writer doesn't count toward it. If heavy mail exceeds the limit, Workers Paid is the
escape hatch (raise CPU limits there).

## Moving an address over from another worker

1. Point a test plus-address (e.g. `jobs+shadow@`) at the watch, or add a temporary literal
   address, and run setup. Watch the ledger and notes for a while.
2. In Email Routing, edit the existing rule for the real address and change its worker to
   `mail-watcher`. The old worker can stay deployed, unrouted, until it is retired.

## Local development

```bash
cp .dev.vars.example .dev.vars   # secrets for wrangler dev
npm run dev
```
