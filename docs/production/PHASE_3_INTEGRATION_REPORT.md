# Phase 3 Integration Report — Estate OS (staging)

Environment: Supabase "Estate OS" (`jvdnapofyoarhfctbpyi`), designated staging on 2026-10-26.

**Labels used:**

| Label | Meaning |
|---|---|
| **Mocked** | Unit test with a fake |
| **Local** | PGlite / Node |
| **Sandbox** | Provider test mode |
| **Staging** | Verified on the staging project |
| **Not tested** | No test ran |
| **Blocked** | Cannot run until something external is provided |

A mocked or local test does not prove that real credentials, network access or provider configuration work.

| # | Integration | What exists | Verification | Result | Remaining requirement |
|---|---|---|---|---|---|
| 1 | **Lead-source webhook** (inbound, HMAC) | `lead-intake` Edge Function; per-integration secret (`rotate_webhook_secret`); timestamped HMAC; bounded body; replay dedupe by event id | **Staging** (`staging-e2e.mjs` INT-01…10, run against the real endpoint) and **Local** (intake suite) | **PASS**. Valid lead → 201 and persisted. Bad signature → 401, nothing saved. A's secret against B → refused, nothing saved. Malformed body → 422. Same event ×5 concurrently → 1 lead. 8 parallel distinct leads → 8 saved | Register each real lead source with its own secret per environment |
| 2 | **Supabase Auth** | Email/password, confirmations on, open signup | **Staging** AUTH-01…07 | **PASS**, with one observation: after logout the refresh token is revoked, but an already-issued access token stays valid until it expires (default 1 h; standard stateless-JWT behaviour) | Leaked-password protection (PRA-008); decide on signup (PRA-016); consider shorter JWT expiry or MFA for owners |
| 3 | **pg_cron → Edge workers** (pg_net + Vault secrets) | 12 jobs; 5 HTTP workers with shared secrets | **Staging**: 15,822 cron runs in 24 h, all succeeded; after the canary deploy every `qualification-worker` call returned 200; wrong secrets → 401 on all 5 workers (FAIL-01) | **PASS** with defect **PRA-031** (LOW): a single cron call to `property-matching-worker` at 18:31:01 UTC got 401 with no log line. The workers answer 401 whenever the secret check does not return `true`, including when the check RPC itself fails, so a transient failure looks like an auth failure. It recovered the next minute; no run was lost | Make workers return 503 and log when the secret check cannot run (distinct from a wrong secret) |
| 4 | **Anthropic (Claude)** | 9 call sites; JSON-schema output; zod validation; deterministic fallbacks; user-triggered calls behind `ai_request_begin` | **Mocked / Local** (validator and guard tests). **Staging**: the four user-triggered functions answer 503 `not_configured`; the workers record `not_configured` and fall back (QUA-02, FUP-03). Guard live: authorization, cross-tenant refusal and the 10/h limit enforced (AI-02…04) | **BLOCKED** for real model calls (no `ANTHROPIC_API_KEY`). The absence is reported honestly; nothing fakes an AI result | Staging key with a spend cap; then run each AI step once and review outputs |
| 5 | **Retell (voice)** | Adapter, call state machine, webhook verification (matches the official SDK) | **Mocked** (golden vector from `retell-sdk` 6.2.12). **Staging**: status reports `retell_configured: false`; pre-call policy blocks; no call record; a forged webhook is refused (HTTP 503, because the verification key is absent) | **BLOCKED** for real calls and webhooks | Retell test agent, a number the team owns, the key in staging; a recorded test call |
| 6 | **Messaging** (email / SMS / WhatsApp) | Agent 05 plans, drafts, gates approval and supports manual sends; the dispatch boundary exists; **no provider adapter** | **Staging**: an approved follow-up says "No provider connected; send manually and mark as sent", with `sent_at` empty (FUP-05). Nothing claims delivery | **NOT IMPLEMENTED** (provider). No false success | Choose a provider and implement the adapter, or run the pilot with manual sending |
| 7 | **Calendar** (Google / Microsoft) | Sync boundary (`calendar_sync_*`, `calendar-sync-worker`); **no adapter** | **Staging**: availability reports `calendar_provider: null`; bookings are internal only (APT-01) | **NOT IMPLEMENTED** | Adapter, or a pilot without calendar sync |
| 8 | **Supabase Storage** (`documents`, private) | Org-scoped object policies | **Local** (isolation suite: documents and storage objects tenant-scoped) | **Local PASS**; not re-run on staging | Upload/read smoke test in the UI once hosted |
| 9 | **Monitoring / error tracking** | None (tables and dashboard logs only) | n/a | **NOT IMPLEMENTED** (PRA-003) | Provider choice; alerts on cron and worker non-200s, failed `agent_runs`, outbox age, webhook rejections, `ai_requests` errors |

## Webhook and event robustness observed on staging

- **Lead webhook:**
  - **Replay:** the same event id returns `duplicate_event`, with no second lead (INT-04, INT-09).
  - **Duplicate person:** a new event for the same person returns `repeat_enquiry` (INT-05).
  - **Bad signature:** recorded as rejected. `webhook_events` currently holds 48 processed and 6 rejected.
- **Outbox:**
  - 243 published, 70 delivered, 12 pending;
  - oldest pending: 0 minutes old when checked (the run's own fresh events);
  - no dead letters.
- **Agent runs:** 140 succeeded, 2 `review_required` (the intended human-review path), 0 failed.
