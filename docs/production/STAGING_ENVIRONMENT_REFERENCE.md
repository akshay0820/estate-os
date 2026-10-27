# Staging Environment Reference — Estate OS

Every variable and secret the code reads, found by searching the code:
- `Deno.env.get(...)` in `supabase/functions`;
- `import.meta.env.*` in `frontend/src`;
- `vault.decrypted_secrets` names in `supabase/migrations`.

No values appear here. Placeholders are in `frontend/.env.example`.

## Browser (public): `frontend/.env.local` or the host's build environment

| Variable | Purpose | Required | Exposure | Used by | How to verify without revealing it |
|---|---|---|---|---|---|
| `VITE_SUPABASE_URL` | Project URL (`https://<ref>.supabase.co`) | Yes for LIVE (without it the app runs in a labelled demo mode) | **Public**, built into the bundle | `src/backend/client` | Network tab shows requests to the staging ref; the ref must be `jvdnapofyoarhfctbpyi` for staging |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable (anon) key; every request is authorized by RLS | Yes for LIVE | **Public** by design | same | Sign-in works; an anonymous REST read of `leads` returns 401 / 42501 |

**Rules:**
- Only `VITE_`-prefixed values reach the browser.
- **Never** put the service-role key, the Anthropic key, the Retell key or any Vault secret in a `VITE_` variable.
- `import.meta.env.DEV` is set by Vite (not configurable).

## Edge Functions: Supabase project secrets (Dashboard → Edge Functions → Secrets, or `supabase secrets set`)

| Variable | Purpose | Required | Exposure | Used by | How to verify without revealing it |
|---|---|---|---|---|---|
| `SUPABASE_URL` | Project URL | Yes | Server | All functions | Platform-injected; nothing to set |
| `SUPABASE_ANON_KEY` | Builds the caller-scoped client in user functions | Yes | Server (public value) | `appointment-assistant`, `crm-enrichment`, `sales-*`, `voice-calls` | Platform-injected |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role client for intake and workers | Yes | **Server-only secret** | `lead-intake`, workers, `voice-*` | Platform-injected. A worker run succeeding (`net._http_response` 200) proves it |
| `ANTHROPIC_API_KEY` | Claude for all 9 AI call sites | Optional (AI features report `not_configured` and fall back) | **Server-only secret** | 10 call sites | `GET /functions/v1/voice-calls/status` → `analysis_configured: true` (signed-in user) |
| `RETELL_API_KEY` | Retell API **and** webhook signature key | Optional (calls are blocked with a reason) | **Server-only secret** | `voice-calls`, `voice-worker`, `voice-webhook` | `voice-calls/status` → `retell_configured: true` |
| `INTAKE_MODEL`, `VOICE_ANALYSIS_MODEL`, `QUALIFICATION_MODEL`, `PROPERTY_MATCHING_MODEL`, `FOLLOW_UP_MODEL`, `APPOINTMENT_MODEL`, `ENRICHMENT_MODEL`, `SALES_INTELLIGENCE_MODEL`, `SALES_ANALYST_MODEL` | Model override per call site (default `claude-opus-5-5`) | Optional | Server (not secret) | One function each | The model name is recorded in `ai_requests.model` / `agent_runs` |

A test account at each provider is required before the corresponding staging test:
- **Anthropic:** an organization or workspace API key with a spend limit.
- **Retell:** a test agent and a phone number the team owns.

## Database: Supabase Vault (`vault.secrets`)

| Name | Purpose | Required | Used by | Verify |
|---|---|---|---|---|
| `voice_worker_url` / `voice_worker_secret` | pg_net target and shared secret for `voice-worker` | Yes for Agent 02 | cron `voice-worker` | `select name from vault.secrets` (names only); the job returns 200 |
| `qualification_worker_url` / `_secret` | same, `qualification-worker` | Yes for Agent 03's AI step | cron `qualification-worker` | same |
| `property_matching_worker_url` / `_secret` | same, `property-matching-worker` | Yes for Agent 04's AI step | cron `property-matching-worker` | same |
| `follow_up_worker_url` / `_secret` | same, `follow-up-worker` | Yes for Agent 05 drafting and dispatch | cron `follow-up-worker` | same |
| `calendar_sync_worker_url` / `_secret` | same, `calendar-sync-worker` | Yes for Agent 06 sync (no adapter yet) | cron `calendar-sync-worker` | same |
| Per-integration webhook secrets | HMAC key per lead source, stored by `rotate_webhook_secret` | Per integration | `lead-intake` via `webhook_secret_for` (service role only) | Signed test webhook accepted; an unsigned one rejected (`webhook_events.status = rejected`) |

**Shared secret rules:**
- Each worker secret is ≥ 32 characters and compared in SQL (`*_secret_ok`).
- The URL must point to the **same** project's function. A staging Vault must never hold a production URL; check with `select name, length(decrypted_secret) from vault.decrypted_secrets` (lengths only) and the `net._http_response` host.

## Supabase Auth (`supabase/config.toml [auth]`; the hosted project takes these from the Dashboard)

| Setting | Staging value | Note |
|---|---|---|
| `site_url` / redirect URLs | `http://localhost:5180` today | Set to the staging host once one exists (PRA-011) |
| `enable_signup` | `true` | Business decision for production (PRA-016) |
| `enable_confirmations` | `true` | Email confirmation required |
| Leaked-password protection | **off** | Dashboard setting (PRA-008) |

## Environment separation checklist (to repeat for production)

1. Production is a **different project ref**. Its `VITE_SUPABASE_URL` must not contain `jvdnapofyoarhfctbpyi`.
2. Production Vault URLs point to the production ref; no value is shared between projects (worker secrets and webhook secrets are generated separately).
3. Provider keys are separate per environment:
   - Anthropic: a separate key or workspace for staging;
   - Retell: separate agents and numbers.
4. Lead-source webhooks are registered per environment with that environment's integration secret. A staging secret cannot validate production traffic, and the reverse is equally impossible.
5. No production data is ever copied into staging; staging uses only the synthetic fixtures.
