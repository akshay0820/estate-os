# Local development

## Prerequisites
* Node 20+ (verified with Node 24) and npm.
* For a live backend: a Supabase project (hosted), or the Supabase CLI + Docker for a local stack.

## Run the frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5180
```

Without Supabase variables the app shows a **"Not connected to a backend"** screen and offers an explicitly labelled demo with sample data stored only in the browser. Demo data is never sent anywhere and never mixes with a live workspace.

## Connect a Supabase project

The hosted project **"Estate OS"** (`jvdnapofyoarhfctbpyi`) already has every migration applied and `lead-intake` deployed. `frontend/.env.local` (git-ignored) points at it with the publishable key, so `npm run dev` starts in live mode. To use a different project:


1. Apply the migrations (see `docs/DATABASE_MIGRATIONS.md`).
2. Copy `frontend/.env.example` to `frontend/.env.local` and set:
   * `VITE_SUPABASE_URL` — project URL
   * `VITE_SUPABASE_PUBLISHABLE_KEY` — publishable/anon key (browser-safe; RLS enforces access)
3. In the Supabase dashboard → Authentication → URL configuration, add `http://localhost:5180` (and your deployed URL) to **Site URL / Redirect URLs** so confirmation and password-reset links return to the app.
4. Recommended Auth settings: email confirmations **on**, minimum password length **8**, leaked-password protection **on**.
5. `npm run dev`, then sign up. The first user creates a workspace and becomes its **owner**; teammates join through invitation links from **Team → Invite member** (shown once; email delivery is not configured yet).

## Deploy the lead-intake Edge Function

```bash
supabase functions deploy lead-intake --no-verify-jwt --project-ref <ref>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase — do not set them yourself and never expose the service-role key to the browser. Then open **Integrations → Generate** in the app to create the signing secret (stored in Supabase Vault, shown once).

Sign requests as `X-Estate-Signature: sha256=<hex(HMAC_SHA256(secret, "<timestamp>.<raw body>"))>` with `X-Estate-Timestamp` (unix seconds, ±5 min) and a unique `X-Estate-Event-Id`.

## Tests

```bash
npm test             # everything (≈ 20 s)
npm run test:db      # database only
npm run typecheck
npm run build
```

Database tests run every migration on **PGlite** (real PostgreSQL 16 compiled to WebAssembly) with a small shim for the Supabase pieces the schema references (`auth.uid()`, roles, `storage`, `vault`): `frontend/tests/db/supabase-shim.sql`. They exercise RLS by switching to the `authenticated` role with a JWT subject, exactly as PostgREST does. No Docker or network needed.

What the shim does *not* cover: Supabase Auth itself (sign-up/sign-in/email flows), PostgREST request handling, the Storage HTTP API and the Edge Function runtime. Those need a running Supabase project (see `docs/API_IMPLEMENTATION_STATUS.md` → Verification).

## Environment variables

| Variable | Where | Required for |
|---|---|---|
| `VITE_SUPABASE_URL` | `frontend/.env.local` | Live mode |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `frontend/.env.local` | Live mode |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Edge Function runtime (auto-injected) | Lead intake |

No other secrets exist in this repository.
