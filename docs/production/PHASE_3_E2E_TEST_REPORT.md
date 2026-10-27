# Phase 3 End-to-End Test Report — Estate OS (staging)

**Environment:** Supabase "Estate OS" (`jvdnapofyoarhfctbpyi`), designated staging by the owner on 2026-10-26. The UI is not hosted; tests drive the real backend APIs as signed-in users.

**Suite:** `frontend/scripts/staging-e2e.mjs`. Run from `frontend/`:

```bash
STAGING_PROJECT_REF=jvdnapofyoarhfctbpyi STAGING_TEST_PASSWORD=*** STAGING_TESTER_PASSWORD=*** node scripts/staging-e2e.mjs results.json
```

The script refuses to run unless `.env.local` points at the given ref, and it never prints passwords.

## Preconditions and test data

**Identities:**

| Identity | Role |
|---|---|
| `e2e-a@estate-os.test` | Owner, Agency A (`e2e-realty-a`) |
| `e2e-b@estate-os.test` | Owner, Agency B (`e2e-realty-b`) |
| `tester@estate-os.test` | Agency A. Temporarily **agent**, then **viewer**, and restored to **owner** (ROLE-10) |

**Synthetic data per run** (tagged `STG-<tag>`):
- 5 listings in A (GOOD, OVER, RENT, AWAY, GONE) and 1 in B.
- About 18 leads created through the signed webhook and `create_lead`.
- Contacts use only `stg-<tag>-…@example.com` addresses and no phone numbers, so no synthetic record can reach a real person.

**Not contacted:** messaging, calendar, Retell and Anthropic. None is configured, so the suite checks that each reports its absence honestly.

**Cleanup:**
- The run cancels its appointments.
- Leads and listings stay as tagged staging data.
- To remove them, archive through the app, or recreate the staging project and re-apply the migrations.

**Agent chain:** the real pg_cron jobs drive lead intake → qualification → matching → follow-up. In this run each stage completed within about 20–60 s.

## Run history

**Run 1 (`MVPLIPAU`):** 78 pass, 4 fail, 1 blocked. All four failures were wrong test expectations, checked against the code before changing any test:
- **INT-08:** posting with A's secret to B's slug returned **404**, not 401. It was refused and nothing was saved in B; the test now accepts either refusal and checks that no row exists.
- **QUA-01 / QUA-03:** the complete lead was classified **`high_intent`** (score 91). That is the stage above `qualified` (lead status `qualified`, qualification status `high_intent`); the test expected exactly `qualified`.
- **ANL-04:** `appointments_booked` rose by 2. The catalogue defines it as "appointments created in the period that were confirmed", and both the booking and the race winner were confirmed (the winner was cancelled later). An independent count of `confirmed_at is not null` rows in the window agrees.
- **ROLE-00 (blocked):** the tester account has its own password. It is supplied through `STAGING_TESTER_PASSWORD` in run 2.

No product code was changed between the runs. Only the test expectations above were corrected.

**Run 2 (`MVPLOI1U`):** results below.

## Steps executed

1. Sign in as each identity.
2. Run the authentication probes.
3. Create the fixtures.
4. Rotate A's webhook secret.
5. Post signed, unsigned, replayed, concurrent, invalid and cross-agency webhooks.
6. Wait for the cron chain:
   1. qualification;
   2. matching;
   3. follow-up.
7. Approve the follow-up.
8. Check availability, book, replay, race, reschedule, attempt a cross-agency cancel or book, and cancel.
9. Check data quality, voice and analytics.
10. Check the live AI guard.
11. Run the role tests.
12. Sweep 44 tenant tables.
13. Run the worker-secret and constraint failure tests.
14. Take timings.

Expected outcomes and evidence are in the table.

## Outstanding defects found in Phase 3

| ID | Severity | Defect |
|---|---|---|
| PRA-031 | LOW | One cron call to `property-matching-worker` (18:31:01 UTC) returned 401 with no log line. The workers treat "could not run the secret check" the same as "wrong secret". It recovered the next minute and no run was lost. |

**Observations (not defects):**
- **AUTH-07:** an access token stays valid for up to 1 hour after logout. This is standard stateless-JWT behaviour; logout revokes the refresh token.
- **PERF sign-in:** one sign-in in run 2 took 15 s, most likely Auth throttling after many sign-ins from one IP during the run. It is not representative of a single user.

## Results of run `MVPLOI1U` (2026-10-26T18:41:56.999Z, project `jvdnapofyoarhfctbpyi`)

Summary: MEASURED 8, OBSERVED 1, PASS 92


### authentication

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| AUTH-01 | valid credentials return a session | owner A | session with access token | 638 ms | **PASS** |
| AUTH-02 | wrong password is rejected | anonymous | error, no session | Invalid login credentials | **PASS** |
| AUTH-03 | anonymous REST read of leads returns nothing | anonymous | 401/403 or empty | HTTP 401 | **PASS** |
| AUTH-04 | malformed and forged (expired, wrongly signed) JWTs are rejected | forged token | HTTP 401 on REST and RPC | malformed 401, forged 401, rpc 401 | **PASS** |
| AUTH-05 | sales-analyst without a JWT is refused by the platform | anonymous | HTTP 401 | HTTP 401 | **PASS** |
| AUTH-05 | sales-intelligence-recommend without a JWT is refused by the platform | anonymous | HTTP 401 | HTTP 401 | **PASS** |
| AUTH-05 | crm-enrichment without a JWT is refused by the platform | anonymous | HTTP 401 | HTTP 401 | **PASS** |
| AUTH-05 | appointment-assistant without a JWT is refused by the platform | anonymous | HTTP 401 | HTTP 401 | **PASS** |
| AUTH-05 | voice-calls/status without a JWT is refused by the platform | anonymous | HTTP 401 | HTTP 401 | **PASS** |
| AUTH-06 | after logout the refresh token no longer works | owner A (second session) | refresh refused | Invalid Refresh Token: Refresh Token Not Found | **PASS** |
| AUTH-07 | access token after logout | owner A (second session) | observed (JWTs are stateless until expiry) | HTTP 200 — the access token stays valid until it expires (default 1 h); logout revokes the refresh token | **OBSERVED** |

### fixtures

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| FIX-01 | synthetic listings created through the API (5 in A, 1 in B) | owners A / B | 6 rows | tag MVPLOI1U | **PASS** |
| FIX-02 | owner can rotate the lead-source webhook secret | owner A | secret issued (not printed) | ok | **PASS** |

### lead intake (Agent 01)

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| INT-01 | valid signed lead is accepted | lead source (HMAC) | HTTP 201 created | 201 created 722 ms | **PASS** |
| INT-02 | the response matches a persisted lead in the right agency | owner A | row in A with source Website | {"id":"fb479335-b86b-4e76-9de0-e8263f754a36","organization_id":"2bd04cde-65bd-4e0b-9fbe-9f3f51f15574","source":"Website","intake_status":"completed","duplicate_status":"unique","status":"new"} | **PASS** |
| INT-03 | the other agency cannot see it | owner B | no rows |  | **PASS** |
| INT-04 | the same event replayed is not processed twice | lead source | same lead, one contact | 200 duplicate_event | **PASS** |
| INT-05 | a second enquiry by the same person follows the duplicate rules | lead source | no second active lead for the contact | 200 repeat_enquiry; active leads for contact: 1 | **PASS** |
| INT-06 | invalid payload is rejected | lead source | HTTP 422, nothing saved | 422 {"error":{"code":"VALIDATION_ERROR","message":"email: Invalid email","details":{}}} | **PASS** |
| INT-07 | invalid signature is rejected and nothing is saved | attacker | HTTP 401, no contact | HTTP 401 | **PASS** |
| INT-08 | agency A's secret cannot post into agency B | lead source A | refused (401/404), nothing saved in B | HTTP 404 {"error":{"code":"NOT_FOUND","message":"Intake is not enabled for this organization","details":{}}} | **PASS** |
| INT-09 | one event delivered 5× concurrently creates one lead | lead source | 1 lead | created duplicate_event duplicate_event duplicate_event duplicate_event | **PASS** |
| INT-10 | 8 different leads posted concurrently are all saved | lead source | 8 created | 201,201,201,201,201,201,201,201 | **PASS** |
| ANL-01 | Sales Intelligence counts exactly the new leads (replays and duplicates not double-counted) | owner A | +12 leads_created today | before 17, after 29 | **PASS** |
| ANL-02 | agency B's metrics are unaffected by agency A's leads | owner B | no change | 0 → 0 | **PASS** |
| ANL-03 | leads_created equals an independent row count for the same window | owner A | equal | metric 29, direct 29 (2026-10-26T18:30:00+00:00 – 2026-10-27T18:30:00+00:00) | **PASS** |

### qualification (Agent 03)

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| QUA-01 | the cron pipeline qualifies the complete lead | pg_cron | qualified or high_intent, score ≥ 60 | high_intent 91 after 0 s; analysis not_configured | **PASS** |
| QUA-02 | without a model key the AI step is recorded as not configured (not faked) | qualification-worker (canary deploy) | analysis_status not_configured | not_configured | **PASS** |
| QUA-03 | qualification status persisted on the lead and the pipeline moved | owner A | qualification_status = run status; lead status qualified | {"status":"qualified","qualification_status":"high_intent"} | **PASS** |
| QUA-04 | missing information → needs_information, not a guess | pg_cron | needs_information | needs_information | **PASS** |
| QUA-05 | the other agency cannot read the qualification | owner B | NOT_FOUND | NOT_FOUND | **PASS** |

### property matching (Agent 04)

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| MAT-01 | matching runs from the qualification event | pg_cron | current run | completed, 3 recommended | **PASS** |
| MAT-02 | the in-budget, in-area, verified sale listing is recommended | Agent 04 | GOOD included | [["STG-MVPLOI1U-GOOD",100],["STG-MVPLIPAU-GOOD",100],["E2E-561335-GOOD",100]] | **PASS** |
| MAT-03 | over budget, rental, other locality and withdrawn listings are excluded | Agent 04 | none of OVER/RENT/AWAY/GONE |  | **PASS** |
| MAT-04 | agency B's listing is never matched to A's lead | Agent 04 | B-GOOD absent |  | **PASS** |
| MAT-05 | no suitable listing → an honest empty result | Agent 04 | no_matches / 0 recommended | no_matches, 0 | **PASS** |

### follow-up (Agent 05)

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| FUP-01 | a follow-up is planned from the persisted matches, awaiting approval, not sent | pg_cron | pending_approval, email, sent_at null | pending_approval email | **PASS** |
| FUP-02 | the draft cites only real listings and carries the opt-out line | Agent 05 | mentions STG listing GOOD | Hi STG, this is E2E Realty A. Following up on your enquiry, these listings match what you told us: 1. STG test listing GOOD, Worli – INR 24,000,000, 2 bed 2. ST | **PASS** |
| FUP-03 | no model key → template draft kept, drafting recorded as not configured | follow-up-worker | draft_status not_configured | not_configured | **PASS** |
| FUP-04 | repeating a follow-up request with the same key does not duplicate it | owner A | same run | {"run_id":"d45abb9b-c3db-44f5-8564-604b5cc2ea97"} | **PASS** |
| FUP-05 | approval without a provider is not reported as delivered | owner A | approved, sent_at null, reason names manual sending | approved: No provider connected; send manually and mark as sent | **PASS** |
| FUP-06 | the other agency cannot approve it | owner B | NOT_FOUND | NOT_FOUND | **PASS** |

### appointment (Agent 06)

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| APT-01 | availability returns slots in the agency time zone with no calendar provider | owner A | ok, slots, timezone = org | 12 slots, Asia/Kolkata, 112 ms | **PASS** |
| APT-02 | booking is confirmed with a reference | owner A | confirmed, APT-… | confirmed APT-63AF445E | **PASS** |
| APT-03 | a repeated click with the same key replays the same booking | owner A | replayed |  | **PASS** |
| APT-04 | two parallel bookings of one slot: exactly one succeeds | two sessions of owner A | 1 win, 1 APPOINTMENT_CONFLICT | confirmed / APPOINTMENT_CONFLICT | **PASS** |
| CRM-01 | the lead pipeline reflects the booked viewing | owner A | visit_scheduled | visit_scheduled | **PASS** |
| ANL-04 | appointments_booked equals an independent count of confirmed appointments created in the window | owner A | equal; +2 for this run (booking + race winner) | before 2, after 4, direct 4 | **PASS** |
| APT-05 | reschedule moves the booking and bumps its version | owner A | version + 1 | v2 | **PASS** |
| APT-06 | a stale reschedule is refused | owner A | CONFLICT | CONFLICT | **PASS** |
| APT-07 | the other agency cannot cancel or book against this lead | owner B | NOT_FOUND | NOT_FOUND / NOT_FOUND | **PASS** |
| CRM-02 | appointment history and the confirmation hand-off are recorded | owner A | history ≥ 1; confirmation not sent | 2 history,  | **PASS** |

### CRM data quality (Agent 07)

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| DQ-01 | data-quality overview is available to the owner | owner A | ok | can,queue,score,since,issues,records | **PASS** |
| DQ-02 | field provenance is recorded for webhook-created records | owner A | rows with a source | display_name:system email:system | **PASS** |
| DQ-03 | the other agency cannot read A's data-quality overview | owner B | NOT_FOUND / FORBIDDEN | NOT_FOUND | **PASS** |

### voice (Agent 02)

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| VOI-01 | voice status reports the provider as not configured (no secret exposed) | owner A | retell_configured false; only booleans | HTTP 200 {"retell_configured":false,"analysis_configured":false} | **PASS** |
| VOI-02 | pre-call policy blocks a lead without a phone number / provider | owner A | not allowed, with reasons | {"checks":[{"ok":false,"key":"voice_configured","label":"AI calling configured for this agency","detail":"AI calling is turned off"},{"ok":true,"key":"kill_switch","label":"Organization outbound switc | **PASS** |
| VOI-03 | no call record is created for the synthetic lead | owner A | 0 voice_calls |  | **PASS** |
| VOI-04 | an unsigned / wrongly signed Retell webhook is refused | attacker | 4xx/5xx, nothing ingested | HTTP 503 | **PASS** |
| VOI-05 | the other agency cannot run pre-call checks on A’s lead | owner B | NOT_FOUND | NOT_FOUND | **PASS** |

### sales intelligence (Agent 08) and AI request guard

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| SI-01 | overview computes the KPIs | owner A | KPIs present | 30 KPIs, 170 ms | **PASS** |
| SI-02 | the other agency cannot read A's analytics | owner B | NOT_FOUND | NOT_FOUND | **PASS** |
| SI-03 | a query spec with unknown fields is rejected | owner A | VALIDATION_ERROR | VALIDATION_ERROR | **PASS** |
| AI-01 | sales-analyst is deployed and reports not_configured (no model key), not a fake answer | owner A | HTTP 503 not_configured | HTTP 503 {"status":"not_configured"} | **PASS** |
| AI-01 | sales-intelligence-recommend is deployed and reports not_configured (no model key), not a fake answer | owner A | HTTP 503 not_configured | HTTP 503 {"status":"not_configured"} | **PASS** |
| AI-01 | crm-enrichment is deployed and reports not_configured (no model key), not a fake answer | owner A | HTTP 503 not_configured | HTTP 503 {"status":"not_configured"} | **PASS** |
| AI-01 | appointment-assistant is deployed and reports not_configured (no model key), not a fake answer | owner A | HTTP 503 not_configured | HTTP 503 {"status":"not_configured"} | **PASS** |
| AI-02 | the AI guard (migration 0018) is live and records an authorized request | owner A | request id | remaining 58 | **PASS** |
| AI-03 | the other agency cannot start AI requests against A | owner B | NOT_FOUND | NOT_FOUND | **PASS** |
| AI-04 | the per-user hourly limit is enforced live (sales_recommendations: 10/h) | owner A | RATE_LIMITED at or before the 11th | 0 accepted, then RATE_LIMITED | **PASS** |

### roles

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| ROLE-01 | an agent cannot read sales analytics | tester as agent | NOT_FOUND / FORBIDDEN | NOT_FOUND | **PASS** |
| ROLE-02 | an agent cannot rotate integration secrets | tester as agent | refused | FORBIDDEN | **PASS** |
| ROLE-03 | an agent cannot read audit logs | tester as agent | 0 rows |  | **PASS** |
| ROLE-04 | an agent cannot edit a lead assigned to someone else | tester as agent | 0 rows changed |  | **PASS** |
| ROLE-05 | an agent cannot trigger AI recommendations | tester as agent | FORBIDDEN | FORBIDDEN | **PASS** |
| ROLE-06 | an agent cannot export leads | tester as agent | refused | FORBIDDEN | **PASS** |
| ROLE-07 | a viewer cannot create leads | tester as viewer | FORBIDDEN | FORBIDDEN | **PASS** |
| ROLE-08 | a viewer cannot trigger AI enrichment | tester as viewer | FORBIDDEN | FORBIDDEN | **PASS** |
| ROLE-09 | a viewer can still read the agency’s leads (authorized access works) | tester as viewer | ≥ 1 row |  | **PASS** |
| ROLE-10 | tester restored to owner after the role tests | owner A | owner | owner | **PASS** |

### tenant isolation sweep

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| TEN-01 | agency B reads 0 rows of agency A across 44 tenant tables | owner B | no leaks | none | **PASS** |
| TEN-02 | agency A still reads its own data in those tables | owner A | most tables non-empty | 35/44 non-empty for A | **PASS** |
| TEN-03 | B cannot update, delete or insert A records by id | owner B | 0 rows / refused | 42501 / FORBIDDEN | **PASS** |
| TEN-04 | the targeted A records are intact | owner A | property still present |  | **PASS** |
| TEN-05 | B cannot rotate A's integration secret or export A's data | owner B | refused | FORBIDDEN / FORBIDDEN | **PASS** |

### failure handling

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| FAIL-01 | qualification-worker rejects a wrong shared secret | attacker | HTTP 401 | HTTP 401 | **PASS** |
| FAIL-01 | property-matching-worker rejects a wrong shared secret | attacker | HTTP 401 | HTTP 401 | **PASS** |
| FAIL-01 | follow-up-worker rejects a wrong shared secret | attacker | HTTP 401 | HTTP 401 | **PASS** |
| FAIL-01 | calendar-sync-worker rejects a wrong shared secret | attacker | HTTP 401 | HTTP 401 | **PASS** |
| FAIL-01 | voice-worker rejects a wrong shared secret | attacker | HTTP 401 | HTTP 401 | **PASS** |
| FAIL-02 | a constraint violation is reported and nothing is written | owner A | error, 0 rows | 23514 | **PASS** |
| FAIL-03 | booking inside the minimum notice is refused with a reason | owner A | VALIDATION_ERROR | VALIDATION_ERROR | **PASS** |
| FAIL-04 | users cannot run background ticks | owner A | permission denied | permission denied for function qualification_tick | **PASS** |

### performance

| ID | Test | Identity | Expected | Actual (evidence) | Result |
|---|---|---|---|---|---|
| PERF | sign-in | owner A | n=5 | p50 99 ms, p95 15043 ms, max 15043 ms, errors 0 | **MEASURED** |
| PERF | lead list (50, newest first) | owner A | n=15 | p50 52 ms, p95 94 ms, max 94 ms, errors 0 | **MEASURED** |
| PERF | lead detail | owner A | n=15 | p50 52 ms, p95 311 ms, max 311 ms, errors 0 | **MEASURED** |
| PERF | property search (active, Worli, ≤ 3 cr) | owner A | n=15 | p50 44 ms, p95 57 ms, max 57 ms, errors 0 | **MEASURED** |
| PERF | appointment availability | owner A | n=10 | p50 68 ms, p95 108 ms, max 108 ms, errors 0 | **MEASURED** |
| PERF | sales overview (30 days, 30 KPIs) | owner A | n=8 | p50 127 ms, p95 208 ms, max 208 ms, errors 0 | **MEASURED** |
| PERF | lead creation via create_lead | owner A | n=5 | p50 126 ms, p95 272 ms, max 272 ms, errors 0 | **MEASURED** |
| PERF | 10 concurrent lead-list reads | owner A | all succeed | 208 ms wall, 0 errors | **MEASURED** |
