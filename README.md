# OmMail AI

**A serverless AI email auto-responder for `support@omhackz.top`.**

OmMail AI listens for new mail through a [DeoMail Fire](https://deomail.com/fire) automation, writes a
reply with [Agnes AI](https://agnes-ai.com), and — only after a set of safety checks — sends it back
through the [DeoMail REST API](https://deomail.com/api). It runs entirely on Vercel serverless
functions: no server, no container, no browser left open.

```
support@omhackz.top  ──►  DeoMail inbox
                            │
                            │  Fire automation (webhook action)
                            ▼
              POST https://mailbot.omhackz.top/api/webhook
                            │
                 ┌──────────▼───────────┐
                 │  OmMail AI (Vercel)  │
                 │  verify → parse →    │
                 │  filter → rate limit │
                 │  → Agnes AI → send   │
                 └──────────┬───────────┘
                            │
              Upstash Redis (state)  +  DeoMail API (send)
```

Repository: <https://github.com/OmHackz/OmMail-Ai> · Issues and setup questions are welcome there.

---

## Table of contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Project layout](#project-layout)
4. [Requirements](#requirements)
5. [Local installation](#local-installation)
6. [Environment variables](#environment-variables)
7. [Create a DeoMail API key](#1-create-a-deomail-api-key)
8. [Create an Agnes AI API key](#2-create-an-agnes-ai-api-key)
9. [Deploy to Vercel](#3-deploy-to-vercel)
10. [Configure DeoMail Fire](#4-configure-deomail-fire)
11. [Connect mailbot.omhackz.top](#5-connect-mailbotomhackztop)
12. [Test the webhook delivery](#6-test-the-webhook-delivery)
13. [Test AI generation](#7-test-ai-generation)
14. [Approve a draft](#8-approve-a-draft)
15. [Safely enable automatic mode](#9-safely-enable-automatic-mode)
16. [Administration dashboard](#10-administration-dashboard)
17. [How the safety rules work](#11-how-the-safety-rules-work)
18. [Troubleshooting](#12-troubleshooting)
19. [Free-tier usage](#13-free-tier-usage)
20. [Known API and platform limitations](#14-known-api-and-platform-limitations)
21. [What you must confirm in the DeoMail dashboard](#15-what-you-must-confirm-in-the-deomail-dashboard)
22. [Testing](#16-testing)
23. [Security notes](#17-security-notes)

---

## Features

- **Three operating modes** — `draft` (safe default: every reply waits for you), `automatic` (sends on
  its own once every check passes), `disabled` (records inbound mail, sends nothing).
- **Layered filters** — never answers newsletters, mailing lists, auto-responders, delivery failure
  notices, spam-flagged mail, or mail from your own addresses.
- **Prompt-injection defence** — inbound text is treated as untrusted data, scanned for injection
  attempts, and suspicious messages are escalated to a human instead of answered.
- **No duplicate replies** — persistent, atomic idempotency across function instances; a message that
  was already answered is never answered twice, even if Fire delivers the webhook again.
- **No blind resends** — if a send times out, the outcome is recorded as *uncertain* and escalated
  rather than retried, because the message may already have been delivered.
- **Rate limits** — per sender, per day, per conversation, and per day overall.
- **Durable state** — Upstash Redis REST (serverless-safe, free tier): processed events, drafts,
  conversation state, daily counters and the activity log.
- **Structured logging** — JSON lines with request id, event, email id, state, error category and
  duration. API keys, secrets and customer email bodies are never logged; addresses are masked.
- **Optional dashboard** — a fast, dependency-free console at `/` with light and dark themes. It only
  works with the admin secret, and no secret or customer body is ever served without it.

---

## Architecture

```
┌──────────────┐        ┌────────────────┐        ┌──────────────────────┐
│   Someone    │ mail   │    DeoMail     │ Fire   │   Vercel (Node 22)   │
│  sends mail  │───────►│    inbox       │───────►│   /api/webhook       │
└──────────────┘        └────────────────┘  POST  │        │             │
                                                │        │  1. verify secret│
                                                │        │  2. parse event   │
                                                │        │  3. claim (SET NX)│
                                                │        │  4. fetch email   │
                                                │        │  5. filter        │
                                                │        │  6. rate limit    │
                                                │        │  7. Agnes AI      │
                                                │        │  8. draft or send │
                                                │        ▼        │        │
                                                │  ┌───────────┐    │        │
                                                │  │  Upstash  │◄───┴────────┘
                                                │  │   Redis   │  state, counters
                                                │  └───────────┘
                                                │
                                                ▼
                                     ┌─────────────────────┐
                                     │  DeoMail REST API   │
                                     │  POST /v1/send      │
                                     └─────────────────────┘
```

**Request flow of `POST /api/webhook`**

| # | Step | Failure behaviour |
|---|------|-------------------|
| 1 | Verify the shared secret (header / query / bearer) | `401`, nothing else runs |
| 2 | Read the body with a hard size limit | `413` |
| 3 | Parse the JSON and map it to an email | `422` |
| 4 | Resolve the mode and settings | `503` when the store is unreachable |
| 5 | Claim the event atomically (`SET NX`) | duplicate → `200 {"status":"duplicate"}` |
| 6 | Fetch the full email from DeoMail (`GET /v1/emails/:id`) | falls back to the webhook preview |
| 7 | Apply the filters | skipped → recorded with a reason |
| 8 | Reserve a rate-limit slot | skipped → recorded with a reason |
| 9 | Ask Agnes AI for a reply | retryable failure → the event stays open |
| 10 | Sanitise the reply | prompt leak → escalated, never auto-sent |
| 11 | Save a draft **or** send it | ambiguous send → recorded as *uncertain* |

---

## Project layout

```
ommail-ai/
├── api/
│   ├── webhook.ts              # POST /api/webhook  (DeoMail Fire entry point)
│   ├── health.ts               # GET  /api/health
│   ├── status.ts               # GET  /api/status   (public, aggregate only)
│   └── admin/
│       ├── index.ts            # GET  /api/admin
│       └── [...path].ts        # /api/admin/<action>
├── src/
│   ├── app.ts                  # pipeline orchestration
│   ├── server.ts               # shared entry-point helpers
│   ├── admin/router.ts         # admin API
│   ├── ai/
│   │   ├── agnes.ts            # Agnes AI client (OpenAI compatible)
│   │   └── prompts.ts          # system prompt, injection scan, output sanitiser
│   ├── email/
│   │   ├── deomail.ts          # DeoMail REST client
│   │   ├── filters.ts          # eligibility and escalation rules
│   │   └── reply.ts            # reply body/subject composition
│   ├── webhook/
│   │   ├── adapter.ts          # Fire payload → canonical email
│   │   ├── verify.ts           # shared secret verification
│   │   └── handler.ts          # transport layer: auth, parsing, responses
│   ├── db/
│   │   ├── storage.ts          # storage interface
│   │   ├── redis.ts            # Upstash Redis REST implementation
│   │   ├── memory.ts           # in-memory implementation (dev/tests only)
│   │   ├── factory.ts          # provider factory
│   │   └── repositories.ts     # typed state operations
│   ├── lib/
│   │   ├── env.ts              # Zod environment validation
│   │   ├── errors.ts           # error categories
│   │   ├── security.ts         # constant-time compare, masking, HTML sanitising
│   │   ├── logger.ts           # structured, redacting logger
│   │   ├── text.ts             # subject/language helpers
│   │   └── http.ts             # JSON responses, body size limit
│   └── types/index.ts
├── tests/                      # 86 automated tests (Vitest)
├── public/                     # dashboard (no build step)
├── .env.example
├── package.json
├── tsconfig.json
├── vercel.json
└── README.md
```

---

## Requirements

- Node.js 22 or newer (the project targets `22.x`; Vercel's Node.js 24 runtime also works — change
  `engines.node` in `package.json` if you prefer).
- A DeoMail account with the `support@omhackz.top` mailbox and API access.
- An Agnes AI account with an API key.
- A free Upstash Redis database (serverless Redis over REST).
- A Vercel account (the Hobby plan is enough).

---

## Local installation

```bash
git clone https://github.com/OmHackz/OmMail-Ai.git ommail-ai
cd ommail-ai
npm install
cp .env.example .env.local     # then fill in the values
npm run dev                    # `vercel dev` — needs the Vercel CLI
```

If you do not have the Vercel CLI installed:

```bash
npm i -g vercel
vercel login
vercel dev
```

`vercel dev` serves the same routes as production, including `/api/webhook` and the dashboard at `/`.

**Local development without a Redis account:** set `STORAGE_PROVIDER=memory`. State is then kept in
the function process only — it disappears on restart and is **not** shared between instances. It is
fine for development, never for production.

**Where the values come from.** `.env.example` is an annotated template — every block names the
dashboard to open. The two secrets you own (`WEBHOOK_SECRET`, `ADMIN_SECRET`) are yours to generate:

```bash
openssl rand -hex 32    # → WEBHOOK_SECRET
openssl rand -hex 32    # → ADMIN_SECRET
```

`.env.local` is git-ignored. Never commit real keys, and never put them in `public/` — the dashboard
is served to the browser.

The commands below read the secrets from the shell so they stay out of your shell history:

```bash
set -a && source .env.local && set +a
```

---

## Environment variables

Copy `.env.example` to `.env.local` (local) or add the variables in
**Vercel → Project → Settings → Environment Variables**.

### Required

| Variable | Example | Notes |
|---|---|---|
| `DEOMAIL_API_KEY` | `deo_live_…` | DeoMail API key. Needs **send** and **read** permissions. |
| `AGNES_API_KEY` | `sk-…` | Agnes AI API key. |
| `WEBHOOK_SECRET` | 32 random hex chars | Shared secret Fire sends. Minimum 16 characters. Generate with `openssl rand -hex 32`. |
| `ADMIN_SECRET` | 32 random hex chars | Protects every `/api/admin/*` route and the dashboard. Minimum 16 characters. |

### DeoMail

| Variable | Default | Notes |
|---|---|---|
| `DEOMAIL_BASE_URL` | `https://api.deomail.com/v1` | |
| `DEOMAIL_SENDER` | `support@omhackz.top` | The `from` address of every reply. Must be a verified DeoMail address. |

### Webhook authentication

| Variable | Default | Notes |
|---|---|---|
| `WEBHOOK_SECRET_HEADER` | `X-Webhook-Secret` | Header Fire sends the secret in. |
| `WEBHOOK_ALLOW_QUERY_SECRET` | `false` | Also accept `?secret=…` (Fire supports query-parameter API keys). |
| `WEBHOOK_SECRET_QUERY_PARAM` | `secret` | Query parameter name. |
| `WEBHOOK_SIGNATURE_ENABLED` | `false` | Optional HMAC-SHA256 body signature. **Off by default: Fire does not document a signature.** |
| `WEBHOOK_SIGNATURE_HEADER` | `X-Webhook-Signature` | Header that would carry `sha256=<hex>`. |

### Agnes AI

| Variable | Default | Notes |
|---|---|---|
| `AGNES_BASE_URL` | `https://apihub.agnes-ai.com/v1` | |
| `AGNES_MODEL` | `agnes-2.5-flash` | Any model the gateway exposes. |
| `AGNES_TEMPERATURE` | `0.5` | |
| `AGNES_MAX_TOKENS` | `500` | Upper bound for the reply length. |
| `AGNES_TIMEOUT_MS` | `25000` | Per-request timeout. |
| `AGNES_MAX_RETRIES` | `2` | Retries for transient failures only. |

### Application and limits

| Variable | Default | Notes |
|---|---|---|
| `AUTO_REPLY_MODE` | `draft` | `draft` \| `automatic` \| `disabled`. The dashboard can override this at runtime. |
| `DEOMAIL_WEBHOOK_PROFILE` | `canonical` | `canonical` \| `extended` — see [Fire configuration](#4-configure-deomail-fire). |
| `APP_NAME` | `OmMail AI` | |
| `APP_URL` | `https://mailbot.omhackz.top` | Shown in the dashboard. |
| `APP_VERSION` | `1.0.0` | |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `AI_SYSTEM_PROMPT` | *(built-in)* | Overrides the default personality. The dashboard can also set it. |
| `REPLY_SIGNATURE` | `Best regards,`⏎`OmHackz`⏎`support@omhackz.top` | Appended to every reply. |
| `MAX_REPLIES_PER_SENDER_DAY` | `3` | |
| `MAX_REPLIES_PER_DAY` | `25` | |
| `MAX_EMAIL_BODY_CHARS` | `12000` | Bodies are truncated beyond this. |
| `MAX_AI_RESPONSE_CHARS` | `4000` | Replies are truncated beyond this. |
| `MAX_WEBHOOK_BYTES` | `256000` | Requests above this are rejected with `413`. |
| `MAX_RETRIES` | `3` | Retry budget for upstream calls. |
| `MAX_CONVERSATION_REPLIES` | `1` | Automatic replies per conversation. |
| `ALLOW_MULTIPLE_REPLIES_PER_CONVERSATION` | `false` | |
| `SELF_DOMAINS` | `omhackz.top` | Comma separated. Never auto-answered. |
| `SELF_ADDRESSES` | `support@omhackz.top` | Comma separated. |
| `ESCALATION_RECIPIENTS` | *(empty)* | Comma separated; shown on escalated drafts. |
| `INJECTION_SENSITIVITY` | `medium` | `low` \| `medium` \| `high`. |
| `SPAM_SCORE_THRESHOLD` / `SPAM_SCORE_MAX` | `6` / `10` | Only used when the provider sends a spam-score header. |

### Storage and admin

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_PROVIDER` | `redis` | `redis` (Upstash) or `memory` (development only). |
| `UPSTASH_REDIS_REST_URL` | — | Required when `STORAGE_PROVIDER=redis`. |
| `UPSTASH_REDIS_REST_TOKEN` | — | Required when `STORAGE_PROVIDER=redis`. |
| `REDIS_PREFIX` | `ommail` | Key prefix, so several apps can share a database. |
| `ADMIN_RATE_LIMIT_PER_MINUTE` | `60` | Per client IP. |

> Secrets are read on the server only. They are never bundled into the dashboard, never written to
> logs, and never returned by an API response.

---

## 1. Create a DeoMail API key

1. Sign in at <https://deomail.com/app/settings>.
2. Open **API Keys** and create a new key.
3. Give it **send** and **read** permissions. The bot needs *read* to fetch the full message when
   Fire only delivers a preview, and *send* to reply.
4. Copy the key (it starts with `deo_live_…`) and store it as `DEOMAIL_API_KEY`.
5. Make sure `support@omhackz.top` is a verified address in your DeoMail account — the API refuses to
   send from an address that is not authorised (`SENDER_NOT_AUTHORIZED`).

DeoMail keys start at **100 requests per hour** across all endpoints. That is enough for a small
studio: one webhook needs at most one read plus one send.

## 2. Create an Agnes AI API key

1. Sign in at <https://agnes-ai.com> and open the developer dashboard.
2. Create an API key and copy it into `AGNES_API_KEY`.
3. The default model is `agnes-2.5-flash` (text and vision, OpenAI-compatible Chat Completions).

Agnes returns `402 Payment Required` when the balance or token-plan quota is exhausted, `401` for a bad
key and `429` when you hit the RPM limit. The client maps all three to distinct error categories and
never retries a `401` or `402`.

## 3. Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel            # first deployment — creates the project
vercel --prod     # production deployment
```

Add the environment variables in the Vercel dashboard (**Settings → Environment Variables**) and
deploy again. The build step is `npm run build`, which runs `tsc --noEmit`; `vercel.json` only sets a
60 second function timeout and a few security headers.

After the first deployment you get a URL such as `https://ommail-ai.vercel.app`. Everything works
there immediately — `/api/webhook`, `/api/health` and the dashboard at `/`.

Check the deployment:

```bash
curl -s https://ommail-ai.vercel.app/api/health
# {"ok":true,"status":"healthy","app":"OmMail AI", ... }
```

> **Node.js runtime.** The handlers use the Web `fetch(request)` export that the Vercel Node.js
> runtime supports. If you pin an older runtime that does not support it, switch to
> `export default async (req, res) => …`. Nothing else in the code has to change.

## 4. Configure DeoMail Fire

Fire watches an address and runs rules. We need one rule: *when mail arrives at `support@omhackz.top`,
POST a JSON event to our webhook.*

1. Open <https://deomail.com/app> → **Automations** (Fire) → **New trigger**.
2. **Trigger** — set the recipient/specific address to `support@omhackz.top`.
3. **Action** — choose **Webhook (HTTP)**.
4. **Method** — `POST`.
5. **Endpoint URL** — your deployed URL:

   ```
   https://mailbot.omhackz.top/api/webhook
   ```

   (or `https://ommail-ai.vercel.app/api/webhook` before the domain is attached).
6. **Authentication** — choose **API Key**, set *Key Name* to `X-Webhook-Secret`, *Location* to
   **Header**, and paste the same value as `WEBHOOK_SECRET`. (Bearer token works too.)
7. **Headers** (optional, recommended) — add `Content-Type: application/json`.
8. **Body template** — paste this JSON. It uses the variables Fire exposes:

   ```json
   {
     "event": "fire.triggered",
     "message_id": "{{email_id}}",
     "from": "{{from}}",
     "to": "{{to}}",
     "subject": "{{subject}}",
     "preview": "{{body}}",
     "received_at": "{{received_at}}",
     "attachment_count": "{{attachment_count}}"
   }
   ```

   This is the same shape DeoMail generates for its own Zapier / n8n / Make presets, which is why the
   adapter treats it as the canonical profile.
9. **Save** and open the trigger's **execution history** to confirm a run was logged.

### Payload profiles

| Profile | When to use it | Expected fields |
|---|---|---|
| `canonical` (default) | The template above. | `message_id`, `from`, `subject`, `preview`, optional `to`, `received_at`, `attachment_count` |
| `extended` | You want the full body and headers in the event. | canonical **plus** `body_text`, `body_html`, `headers` |

Set `DEOMAIL_WEBHOOK_PROFILE=extended` when you use the extended template. The adapter also accepts
a small, explicit alias table (`email_id`/`id` for the message id, `from_addr`/`sender` for the
sender, `body`/`text`/`snippet` for the body, …) so a slightly different template keeps working.
Unknown fields are ignored, never interpreted.

> **Why the full body is fetched from the API anyway.** Fire's `{{body}}` may be a truncated preview.
> When that happens OmMail AI calls `GET /v1/emails/{email_id}` and uses the complete message. If
> that call fails, the preview is used and the event is logged.

## 5. Connect `mailbot.omhackz.top`

1. In Vercel: **Project → Settings → Domains → Add** → `mailbot.omhackz.top`.
2. Vercel shows the DNS records to add (usually an `A` record to `76.76.21.21` and/or a `CNAME` to
   `cname.vercel-dns.com`).
3. Add them at your DNS provider and wait for the records to propagate.
4. The DeoMail Fire endpoint stays the same — you only change the hostname, not the path.

After the domain is live, `https://mailbot.omhackz.top/api/webhook` is the production webhook and
`https://mailbot.omhackz.top/` is the dashboard.

## 6. Test the webhook delivery

With the project running (locally or deployed), send a test event:

```bash
curl -i -X POST https://mailbot.omhackz.top/api/webhook \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{
    "event": "fire.triggered",
    "message_id": "email-test-0001",
    "from": "Jane Customer <jane@example.com>",
    "to": "support@omhackz.top",
    "subject": "Question about your services",
    "preview": "Hi, I would like to know whether you take on small software projects. Thanks!",
    "received_at": "2026-11-13T10:00:00.000Z",
    "attachment_count": "0"
  }'
```

Expected response (draft mode):

```json
{ "ok": true, "status": "draft_created", "draftId": "…", "detail": null, "escalated": false }
```

Other responses you may see:

| Response | Meaning |
|---|---|
| `401 {"error":"unauthorized"}` | The secret header is missing or wrong. |
| `413` | The body exceeded `MAX_WEBHOOK_BYTES`. |
| `422` | The payload did not match the profile (usually no usable sender address). |
| `200 {"status":"duplicate"}` | This message was already processed. |
| `200 {"status":"skipped","detail":"auto_responder_sender"}` | A filter stopped it. |
| `200 {"status":"failed","retryable":true}` | A transient upstream error; Fire may deliver again. |
| `200 {"status":"send_uncertain"}` | The send timed out — a human must check. |

**Send a real email** to `support@omhackz.top` and watch the Fire execution history. If the run fails,
open it: it shows the request and the response from our endpoint, which is the fastest way to spot a
wrong secret or a mismatched body template.

## 7. Test AI generation

The dashboard has a **Try the assistant** box on the overview page — paste a message and get a reply
without sending mail.

From the command line:

```bash
curl -s -X POST https://mailbot.omhackz.top/api/admin/test-ai \
  -H 'Content-Type: application/json' \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{"message":"Hi, do you support existing integrations?","subject":"Support question"}'
```

```json
{ "ok": true, "model": "agnes-2.5-flash", "usage": { … }, "reply": "Hi — yes, …", "issues": [] }
```

Check the credentials independently:

```bash
curl -s https://mailbot.omhackz.top/api/admin/connection -H "X-Admin-Secret: $ADMIN_SECRET"
# {"ok":true,"deomail":{"ok":true},"agnes":{"ok":true,"model":"agnes-2.5-flash"}}
```

## 8. Approve a draft

1. Open the dashboard at `https://mailbot.omhackz.top/` and enter `ADMIN_SECRET`.
2. Go to **Reply queue**. Each draft shows the customer, the subject and the reply text.
3. Edit the text in place if you want to change it.
4. Press **Approve & send** — the reply goes out through the DeoMail API and the draft is marked
   *sent*. **Discard** drops it, **Rewrite** asks Agnes for a new version.

The same thing from the command line:

```bash
# the id of the draft you want to send
DRAFT_ID=$(curl -s 'https://mailbot.omhackz.top/api/admin/drafts?limit=1&status=pending' \
  -H "X-Admin-Secret: $ADMIN_SECRET" | jq -r '.drafts[0].id')

curl -s -X POST "https://mailbot.omhackz.top/api/admin/drafts/$DRAFT_ID/approve" \
  -H 'Content-Type: application/json' \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{}'
```

Approving twice returns `409` — a draft can only be sent once.

## 9. Safely enable automatic mode

1. **Stay in draft mode** for a few days. Read the drafts, adjust the system prompt, add the facts the
   assistant is missing. The prompt is editable in **Settings**.
2. Fill in the boundaries the model must not cross (prices, contracts, refunds, deadlines). The default
   prompt already forbids inventing them, but specific facts are better written down.
3. Lower the limits while you watch: `MAX_REPLIES_PER_DAY=10`, `MAX_REPLIES_PER_SENDER_DAY=2`.
4. Switch the dashboard mode selector to **Auto** (or set `AUTO_REPLY_MODE=automatic`).
5. Watch **Activity** for a week. Escalated messages still need you — that is the safety net working.

To go back: set the mode to **Draft** or **Off** in the dashboard. The change takes effect on the very
next inbound message; no redeploy is needed.

## 10. Administration dashboard

The dashboard lives at `/` and is a single static page — no build step, no framework, no secrets in
the bundle.

- **Overview** — processed, written, sent, waiting, skipped and failed counters, today's tally, and a
  sandbox to try the assistant.
- **Reply queue** — pending and escalated drafts, editable, with approve / rewrite / discard.
- **Activity** — a timeline of every inbound event with its reason code.
- **Settings** — system prompt, signature, operating mode, and the DeoMail / Agnes connection state.
- Light and dark themes, keyboard accessible, responsive down to a phone.

The admin secret is kept in `sessionStorage` (this browser tab only) and sent in the `X-Admin-Secret`
header. Nothing sensitive is served without it.

---

## 11. How the safety rules work

**Never answered automatically**

- Mail from your own addresses or domains (`SELF_ADDRESSES`, `SELF_DOMAINS`) — this is what stops
  auto-reply loops.
- Auto-responders: `Auto-Submitted` (unless `no`), `X-Auto-Response-Suppress`, `Precedence:
  bulk|junk|list|auto_reply`, `List-Unsubscribe`, `List-Id`, well-known senders (`noreply@`,
  `mailer-daemon@`, `postmaster@`, `notifications@`, …), and subjects such as *out of office*,
  *automatic reply*, *undelivered mail*, *delivery status notification*, *unsubscribe*, *newsletter*.
- Spam: `X-Spam-Flag: YES`, `X-Spam-Status`, or a spam score at or above `SPAM_SCORE_THRESHOLD`.
- Empty bodies and malformed senders.

**Escalated — answered, but never sent automatically**

- Prompt-injection attempts (`ignore all previous instructions`, `reveal your system prompt`,
  `send the API key to …`, `you are now …`, `developer mode`, …).
- Phishing heuristics: reply-to domain mismatch, shortened or suspicious URLs, urgency language,
  credential requests.
- Sensitive topics: credentials, invoices, contracts, legal matters, threats or fraud.

Escalated messages still get a drafted reply so you can send it yourself — but they are never sent
automatically and are marked **escalated** in the queue.

**Idempotency**

Every message is claimed with an atomic `SET … NX` in Redis before any work starts, and the outcome is
stored under the same key for 90 days. A duplicate delivery (Fire retry, double click, two Fire rules)
returns `{"status":"duplicate"}` without generating or sending anything. Concurrent deliveries of the
same message are handled by the same lock.

**Ambiguous sends**

If the DeoMail send times out or the connection drops, the message may already have been delivered. In
that case the event is closed as `send_uncertain`, the draft is marked *failed* for review, and
nothing is resent automatically.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401` from `/api/webhook` | The secret header does not match `WEBHOOK_SECRET`. | Re-copy the secret into the Fire action. Check for a trailing space. |
| `422` from `/api/webhook` | The payload does not match the profile. | Open the Fire execution history, copy the delivered body, compare it with the template above. |
| `duplicate` on every event | The same `message_id` is being reused. | Fire must send `{{email_id}}`; a constant value would look like one message. |
| `configuration_error` | A required environment variable is missing. | `GET /api/health` lists the missing **names** (never values). |
| `Agnes AI authentication failed` | Wrong or expired `AGNES_API_KEY`. | Create a new key in the Agnes dashboard. |
| `Agnes AI quota exhausted` | Agnes balance or token plan is empty. | Top up, or lower `AGNES_MAX_TOKENS`. |
| `DeoMail authentication failed` | Wrong `DEOMAIL_API_KEY`. | Create a new key with send + read permissions. |
| `DeoMail refused the request` / `SENDER_NOT_AUTHORIZED` | `DEOMAIL_SENDER` is not a verified address. | Set it to the address you own in DeoMail. |
| `DeoMail rate limit reached` | 100 requests/hour exhausted. | Ask DeoMail to raise the limit, or lower the reply volume. |
| `FINGERPRINT_REQUIRES_PLAN` | Someone disabled Fingerprint on a free plan. | Leave Fingerprint enabled (the default) — OmMail AI never sends `fingerprint: false`. |
| `skipped` with `daily_limit` | The daily budget is used up. | Raise `MAX_REPLIES_PER_DAY` or wait for the next UTC day. |
| `send_uncertain` | The send timed out. | Check the recipient's inbox; send manually if needed. Do not re-trigger blindly. |
| The dashboard asks for the secret again | The tab was closed or the session expired. | Re-enter `ADMIN_SECRET`. |
| `429` from the dashboard | Admin rate limit (60/min per IP). | Wait a minute. |

**Logs.** On Vercel, open the project → **Logs** → **Function** → filter on `webhook.` or `reply.`.
Each line is JSON with `ts`, `level`, `event`, `requestId`, `emailId`, `state`, `errorCategory` and
`durationMs`.

## 13. Free-tier usage

| Service | Free allowance | How OmMail AI uses it |
|---|---|---|
| Vercel (Hobby) | 100 GB bandwidth, 1M function invocations/month, 12 functions | 5 functions, tiny payloads. |
| DeoMail API | 100 requests/hour, all endpoints combined | ~2 requests per answered mail (1 read + 1 send). |
| DeoMail Fire | 50 runs/day | One run per inbound message. |
| DeoMail sending | Daily mail quota of the plan | One reply per approved draft. |
| Upstash Redis | 10 000 requests/day, 256 MB | ~6 Redis calls per inbound mail. |
| Agnes AI | Free gateway, per-account quota | One completion per answered mail. |

A quiet week costs well under 1 % of every free tier. The app is designed to fail closed: when Redis
is unreachable the webhook reports `503` rather than replying without deduplication.

## 14. Known API and platform limitations

These are real constraints of the upstream APIs, not bugs in this project.

1. **DeoMail Fire has no documented inbound webhook schema.** The body of a Fire webhook is the JSON
   template *you* configure. OmMail AI implements a documented canonical profile and an explicit alias
   table instead of guessing at arbitrary shapes.
2. **DeoMail Fire has no documented signature.** There is no HMAC header and no signature field in
   the Fire UI. The shared secret therefore travels in a custom header (Fire's *API Key → Header*
   authentication), optionally in a query parameter or as a bearer token. An HMAC verifier is included
   but disabled (`WEBHOOK_SIGNATURE_ENABLED=false`).
3. **Fire retry behaviour is not documented.** The execution history offers a manual *retry* option.
   OmMail AI therefore never relies on Fire to retry: transient failures are retried inside the
   function, and the event stays open so a later delivery can pick it up.
4. **`{{body}}` may be a truncated preview.** The complete body is fetched from `GET /v1/emails/:id`.
5. **DeoMail's send endpoint does not document `Reply-To`, `In-Reply-To` or `References`.** Only
   `from`, `to`, `cc`, `bcc`, `subject`, `text`, `html`, `attachments` and `fingerprint` are sent.
   Threading therefore relies on the subject line (`Re: …`); the original message id is recorded in
   storage but never forged into a header.
6. **A successful send is not a delivery guarantee.** DeoMail accepts the message; final delivery
   depends on the receiving server. The app records the send, not an inbox arrival.
7. **DeoMail returns logical errors with HTTP 200.** The client inspects the `error`/`code` fields in
   every response, not just the status code.
8. **Fingerprint verification is on by default** for API sends and cannot be disabled on the free plan.
   OmMail AI never disables it.
9. **Agnes error codes**: `401` auth, `402` quota, `429` rate limit, `400/404` bad request, `408/504`
   timeouts, `5xx` transient. Only the transient ones are retried.
10. **Upstash Redis REST is used instead of the official SDK** so the bundle stays small and no
    long-lived connection is opened. Every call is a plain `fetch`.

## 15. What you must confirm in the DeoMail dashboard

The DeoMail integration is built on the published documentation (`deomail.com/api`, `deomail.com/fire`,
the OpenAPI description and the Fire UI). These points are **not** documented and must be confirmed
with a real Fire test event before you rely on them:

- [ ] **The exact body Fire delivers.** Open the Fire trigger's *execution history*, copy the request
      body, and check it against the canonical template. If your Fire version uses different field
      names, either adjust the template or extend `FIELD_ALIASES` in `src/webhook/adapter.ts`.
- [ ] **Whether Fire sends your custom headers.** The Fire FAQ states custom headers are supported;
      confirm the secret header actually arrives (a `401` means it did not).
- [ ] **Whether `{{body}}` is truncated.** Compare the `preview` value in the execution history with
      the full message in the DeoMail inbox.
- [ ] **Whether Fire retries failed deliveries automatically.** If it does, confirm the backoff is
      long enough that our idempotency window (90 days) still protects you — it does, but the Fire
      run history gets noisy.
- [ ] **Which variables your Fire version exposes.** The UI advertises `{{from}}`, `{{to}}`,
      `{{subject}}`, `{{body}}`, `{{email_id}}`; the Zapier-style presets also use `{{received_at}}`
      and `{{attachment_count}}`. Confirm which ones your account renders.
- [ ] **The Fire run quota.** The docs state 50 runs/day on the free plan; confirm the number shown in
      your account and raise it if inbound volume is higher.
- [ ] **Whether `{{email_id}}` matches the id used by `GET /v1/emails/:id`.** If it does not, the
      fallback to the webhook preview is used (and logged as `email.fetch_missing`).
- [ ] **That the API key has both `send` and `read` permissions**, and that `support@omhackz.top` is
      a verified sender.

Nothing in this repository has been tested against a live DeoMail Fire delivery or a live Agnes key —
the upstream services are exercised through mocked HTTP responses in the test suite. The code follows
the published API documentation exactly, but the checklist above is what closes the loop.

## 16. Testing

```bash
npm test              # 86 tests, ~3 seconds
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit
npm run build         # same as typecheck (the Vercel build step)
```

The suite mocks both upstream APIs and covers: valid webhook processing, invalid authentication,
duplicate delivery, self-mail loop prevention, auto-responder detection, spam filtering, draft
creation, successful AI generation, successful sending, Agnes timeouts, DeoMail failures, daily rate
limits, concurrent duplicate events, missing environment variables, prompt-injection attempts, the
admin approval flow, and the storage/idempotency primitives.

```
tests/
├── webhook.test.ts   # the pipeline, end to end
├── ai.test.ts        # Agnes client: success, timeout, auth, quota, retries
├── deomail.test.ts   # DeoMail client: send, read, list, errors, retry policy
├── filters.test.ts   # filters, injection detection, sanitising, text helpers
├── admin.test.ts     # admin auth, approval, settings, activity, rate limit
├── storage.test.ts   # Redis REST semantics, idempotency, quotas
├── env.test.ts       # environment validation
└── api.test.ts       # the Vercel function entry points
```

## 17. Security notes

- The webhook **fails closed**: without a valid secret nothing is processed, and no reply is ever
  generated for an unauthenticated request.
- Secrets live only in environment variables. They are never bundled into the dashboard, never logged
  and never returned by an API response.
- The admin secret is compared in constant time; the webhook secret too.
- Customer email addresses are masked in logs (`j***@e***.com`) and full bodies are never logged.
- Inbound email is treated as untrusted data: it is delimited in the prompt, scanned for injection
  attempts, and never treated as instructions.
- HTML that leaves the system is built by the app, not copied from the incoming message.
- Admin endpoints are rate limited per IP and every response is `Cache-Control: no-store`.
- `vercel.json` sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and a restrictive
  `Permissions-Policy`.

---

## Licence

Private project for OmHackz. Add your own licence before publishing.
