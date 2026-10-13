# Config reference

Generated from the config schema by `npm run build`. Do not edit by hand.

Every key of `mail-watcher.yaml`. Defaults for prompts, messages and link templates are in
`config/defaults.yaml`. Keys ending in `_secret` hold the *name* of a Worker secret.

| Key | Type | Default | Description |
|---|---|---|---|
| `mailbox` | object |  |  |
| `mailbox.inbox` | string (email) |  | Main inbox. Must be a verified Email Routing destination. |
| `mailbox.link` | string |  | Mailbox link template. {message_id}, {authuser} and {subject} are URL-encoded. |
| `mailbox.search` | string |  | Fallback link template when the mail has no Message-ID. |
| `mailbox.authuser` | string | `"0"` | Gmail account (index or address) the link opens. |
| `models` | object |  |  |
| `models.classify` | object |  | Jev (TypeSafe), the only classifier. |
| `models.classify.url` | string (uri) | `"https://api.typesafe.ai/v1/systemone"` |  |
| `models.classify.model` | string | `"jev-latest"` |  |
| `models.classify.key_secret` | string | `"TYPESAFE_API_KEY"` |  |
| `models.write` | object |  | Model that writes notes, extracts fields and writes the digest. |
| `models.write (provider: workers-ai).provider` | `"workers-ai"` |  |  |
| `models.write (provider: workers-ai).model` | string |  | Workers AI model id, e.g. @cf/meta/llama-3.3-70b-instruct-fp8-fast. |
| `models.write (provider: workers-ai).max_tokens` | integer | `400` |  |
| `models.write (provider: openai-compatible).provider` | `"openai-compatible"` |  |  |
| `models.write (provider: openai-compatible).base_url` | string (uri) |  | Base URL; `/chat/completions` is appended. |
| `models.write (provider: openai-compatible).model` | string |  |  |
| `models.write (provider: openai-compatible).key_secret` | string |  | Name of the secret holding the API key. |
| `models.write (provider: openai-compatible).max_tokens` | integer | `400` |  |
| `prompts` | object |  |  |
| `prompts.classify` | string |  | Jev instructions. Placeholders: {watch}, {hint}. |
| `prompts.write` | string |  | Writer prompt. Placeholders: {watch}, {category}, {description}, {hint}, {fields}, {from}, {subject}, {body}. |
| `prompts.digest` | string |  | Digest prompt. Placeholders: {days}, {stats}, {subjects}. |
| `redact` | object |  |  |
| `redact.detectors` | object |  |  |
| `redact.detectors.link` | boolean | `true` |  |
| `redact.detectors.email` | boolean | `true` |  |
| `redact.detectors.phone` | boolean | `true` |  |
| `redact.detectors.code` | boolean | `true` |  |
| `redact.detectors.number` | boolean | `true` |  |
| `redact.detectors.address` | boolean | `true` |  |
| `redact.detectors.secret` | boolean | `true` |  |
| `redact.phone_regions` | string[] |  | Regions tried for phone numbers written without +. |
| `redact.custom` | object[] |  |  |
| `redact.custom[].kind` | string |  | Placeholder kind; the text becomes `[KIND]`. |
| `redact.custom[].pattern` | string |  | JavaScript regex source. Avoid nested quantifiers (CPU budget). |
| `redact.custom[].flags` | string | `"i"` |  |
| `redact.custom[].context` | string[] |  | Only redact when one of these words is within `window` characters. |
| `redact.custom[].window` | integer | `40` |  |
| `redact.custom[].validator` | `"luhn"` \| `"mod97"` |  |  |
| `redact.custom[].score` | number | `0.7` | Overlap tie-breaker; higher wins. |
| `redact.body_cap` | integer | `20000` | Characters of body kept (CPU budget). |
| `channels` | map |  | Named channel instances: { type, ...settings }. |
| `channels.<name>` | object |  |  |
| `channels.<name> (type: telegram).chat_id` | string |  | Chat that receives the notes (a user, group or channel id). |
| `channels.<name> (type: telegram).token_secret` | string |  | Name of the secret holding the bot token from @BotFather. |
| `channels.<name> (type: telegram).type` | `"telegram"` |  |  |
| `channels.<name> (type: webhook).url` | string (uri) |  | Endpoint that receives the note as a JSON POST. |
| `channels.<name> (type: webhook).token_secret` | string |  | Name of a secret sent as `Authorization: Bearer <value>`. |
| `channels.<name> (type: webhook).type` | `"webhook"` |  |  |
| `watches` | object[] |  | Ordered; the first matching watch wins. |
| `watches[].name` | string |  |  |
| `watches[].match` | object |  | Every given field must match. An empty match catches all mail. |
| `watches[].match.to` | string \| string[] |  | A glob (`*` any run, `?` one character, case-insensitive) or a list of globs; any may match. |
| `watches[].match.from` | string \| string[] |  | A glob (`*` any run, `?` one character, case-insensitive) or a list of globs; any may match. |
| `watches[].match.subject` | string \| string[] |  | A glob (`*` any run, `?` one character, case-insensitive) or a list of globs; any may match. |
| `watches[].hint` | string | `""` | Guidance for the writer, specific to this watch. |
| `watches[].fields` | map |  | Fields the writer extracts: name → description. Stored in the ledger. |
| `watches[].extract` | `"notify"` \| `"always"` | `"notify"` | `always` runs the writer for fields on every mail, not just notifying mail. |
| `watches[].categories` | map |  |  |
| `watches[].categories.<name>` | object |  |  |
| `watches[].categories.<name>.description` | string |  | Plain-language criteria Jev judges the email against. |
| `watches[].categories.<name>.forward` | `"inbox"` \| string (email) |  | Address to forward to, or "inbox" for `mailbox.inbox`. Must be a verified Email Routing destination. |
| `watches[].categories.<name>.notify` | string[] |  | Channel instances that receive a note. |
| `watches[].categories.<name>.min_confidence` | number |  | Below this Jev probability the watch's `uncertain` action applies. Default 0, or 0.8 when the category does not forward. |
| `watches[].categories.<name>.reveal` | string[] |  | Placeholder kinds whose original values are appended to the note, e.g. [PHONE]. |
| `watches[].uncertain` | object |  | Action when Jev's confidence is below the category's min_confidence. |
| `watches[].uncertain.forward` | `"inbox"` \| string (email) |  | Address to forward to, or "inbox" for `mailbox.inbox`. Must be a verified Email Routing destination. |
| `watches[].uncertain.notify` | string[] |  | Channel instances that receive a note. |
| `watches[].on_error` | object |  | Action when Jev fails. Must forward. |
| `watches[].on_error.forward` | `"inbox"` \| string (email) |  | Address to forward to, or "inbox" for `mailbox.inbox`. Must be a verified Email Routing destination. |
| `watches[].on_error.notify` | string[] |  | Channel instances that receive a note. |
| `watches[].silence_hours` | number |  | Alert when this watch gets no mail for this many hours. |
| `default` | object |  | Action for mail matching no watch. |
| `default.forward` | `"inbox"` \| string (email) |  | Address to forward to, or "inbox" for `mailbox.inbox`. Must be a verified Email Routing destination. |
| `default.notify` | string[] |  | Channel instances that receive a note. |
| `alerts` | object |  |  |
| `alerts.channels` | string[] |  |  |
| `alerts.throttle_minutes` | number | `60` | At most one alert per kind per window. |
| `alerts.messages` | object |  |  |
| `alerts.messages.jev` | string |  |  |
| `alerts.messages.writer` | string |  |  |
| `alerts.messages.forward` | string |  |  |
| `alerts.messages.channel` | string |  |  |
| `alerts.messages.config` | string |  |  |
| `alerts.messages.selftest` | string |  |  |
| `alerts.messages.silence` | string |  |  |
| `texts` | object |  | Short texts the code fills in. |
| `texts.silence_detail` | string |  | Silence alert detail. Placeholders: {watch}, {hours}, {limit}. |
| `texts.digest_fallback` | string |  | Digest text when the writer fails. Placeholders: {days}, {counts}. |
| `texts.digest_empty` | string |  | {counts} when there was no mail. |
| `schedules` | object |  |  |
| `schedules.selftest` | string |  | Cron for the self-test and silence check. |
| `schedules.digest` | string |  | Cron for the digest. |
| `schedules.digest_channels` | string[] |  |  |
| `schedules.digest_days` | integer | `7` |  |
| `selftest` | object |  | The canned email the self-test runs through the pipeline. |
| `selftest.watch` | string |  | Watch whose categories the sample is classified against. Default: the first. |
| `selftest.from` | string |  |  |
| `selftest.subject` | string |  |  |
| `selftest.body` | string |  |  |
| `selftest.expect` | string |  | Category Jev must pick for the self-test to pass. |
| `retain_days` | integer | `30` | Days raw .eml files stay in R2. 0 turns retention off. |
| `dashboard` | object |  | Without `access` (or `unprotected`), the dashboard is off. |
| `dashboard.access` | object |  |  |
| `dashboard.access.team_domain` | string |  | Cloudflare Access team domain, e.g. myteam.cloudflareaccess.com. |
| `dashboard.access.aud` | string |  | Application Audience (AUD) tag. |
| `dashboard.unprotected` | boolean | `false` | Serve without checking Access. Only for local development. |
