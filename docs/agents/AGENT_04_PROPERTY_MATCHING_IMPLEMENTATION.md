# Agent 04 — AI Property Matching Agent (`property_matching_agent`)

Status: **implemented and verified** (2026-10-25). The optional Claude summary step is wired, but no real call has been made yet (no API key). Sections 1–9 are the plan; 10 onward record what was built.

## 1. Discovered architecture (2026-10-25)

| Area | Found | Decision |
|---|---|---|
| Backend | Supabase Postgres + RLS. Rules live in SECURITY DEFINER SQL; Deno Edge Functions handle provider/LLM HTTP; pg_cron is the scheduler | Same split as Agents 01–03: deterministic SQL engine, optional Claude step in an Edge Function |
| Runtime | `agent_runs` / `agent_run_steps` (retries, dead letter), `outbox_events` + `outbox_claim/ack`, `private.emit_event` | Reused. Agent 04 is the `property_matching_agent` outbox consumer |
| Upstream | `lead.qualification.completed` (Agent 03, consumer `property_matching_agent`, ids only, deduped on requirements) | Consumed. The payload is never trusted beyond ids; lead and qualification are re-read in the event's org |
| Requirements | `lead_qualifications.requirements` (per field `{value, certainty: confirmed / ai_extracted / stated / inferred, source}`) plus `leads.required_amenities` | **Only `confirmed` (CRM, set by a person) values are hard constraints.** AI-extracted, stated (call) and inferred values are soft preferences |
| Inventory | `public.properties`, owned by one organization. Status `draft / active / under_offer / reserved / let / sold / withdrawn / archived`; `listing_type` `sale / rent`; price + currency; bedrooms, bathrooms, area + unit, furnishing, locality, city, amenities; `verified_at` (only `properties.verify` can set it; the server stamps the time) | The only inventory source. There is no partner sharing or external feed in the product, so scope = the organization's own listings |
| Search | B-tree indexes `(organization_id, status, listing_type, price)` and `(organization_id, locality, status)`; no PostGIS, no coordinates, no vector or full-text search | Bounded SQL retrieval on the existing index; normalized text matching on locality / city, plus configurable aliases. No distance or commute claims (no coordinates exist) |
| Existing matching | `lib/domain.ts → matchProperties`: client-side ranking in the lead drawer's **Property matches** tab (it also powers demo mode) | Live mode switches the tab to backend results. Demo mode keeps the client function |
| Currency | No FX service. Org default currency INR | Different currencies are never compared: budget fit = unknown, with a caveat |
| Rent period | No price-period column. The product shows rent as per month (`/mo`), and lead rent budgets are monthly | Both treated as monthly; documented, nothing to convert |
| Viewing | Appointments refuse viewings of non-active properties (`PROPERTY_UNAVAILABLE`) | Reused as the final check before a viewing |

## 2. Data model (additive migration 0013)

- `property_matching_settings` (per org, optional): versioned `rules` jsonb, validated by `property_matching_settings_save`.
- `property_match_runs`: one row per completed matching run, so history is kept; exactly one per lead is `is_current`. Each row holds:
  - outcome status, criteria snapshot, inventory scope;
  - counts (inventory, candidates, eligible, recommended) and rejection counts per reason code;
  - warnings, missing information, ruleset version;
  - explanation (Claude) status, model metadata;
  - results fingerprint, run id, trigger.

  Runs still in flight (pending / processing / failed / retrying) are tracked in `agent_runs`, like Agent 03.
- `property_matches`: one row per recommended property per run. Each row holds:
  - rank, score (0–100) and band, plus the breakdown;
  - strengths, trade-offs and caveats as `{code, text}`;
  - availability (`verified / stale / unverified`) and budget fit;
  - template explanation, plus an optional AI summary;
  - a property snapshot at matching time, so price or status changes are detectable;
  - lifecycle status and the human decision fields.
- Lifecycles (different entities, different states):
  - **Run:** `completed`, `completed_with_warnings`, `needs_more_information`, `no_matches`, `not_applicable` (seller / landlord leads). In flight: `agent_runs` `received` / `retry_scheduled` / `dead_letter`. **Outdated** when the lead's current qualification is newer than the run's.
  - **Recommendation:** `recommended → viewed → shortlisted → shared → appointment_requested`, or `rejected`, or `invalidated` (the listing changed). Human decisions carry over to the next run for the same property.

## 3. Eligibility (hard constraints, deterministic)

| Code | Rule |
|---|---|
| `TRANSACTION_TYPE_MISMATCH` | buy / invest → `sale` listings; rent → `rent`. Sell / let leads are not matched to inventory (`not_applicable`) |
| `LISTING_UNAVAILABLE` | Only `active` listings. `under_offer` / `reserved` are retrieved and rejected; drafts and closed listings are never retrieved |
| `REQUIRED_DATA_UNVERIFIED` | Only when the org sets `unverified_policy = exclude`. The default (`flag`) keeps them, labelled unverified |
| `EXCEEDS_HARD_BUDGET` | A confirmed budget max is approximate: up to `budget_flex_pct` (default 10%) over is allowed and labelled "over budget"; beyond that is excluded. `budget_flex_pct = 0` makes it a strict maximum. Stated or inferred budgets never exclude |
| `OUTSIDE_MANDATORY_LOCATION` | Confirmed locations are mandatory unless `location_flexible = true`. Stated or inferred locations never exclude |
| `PROPERTY_TYPE_MISMATCH` | A confirmed type excludes other categories (residential / land / commercial / other). A different type in the same category is a trade-off |
| `BEDROOM_REQUIREMENT_NOT_MET` | A confirmed bedroom count excludes listings with fewer bedrooms |
| `BELOW_MIN_SCORE` | Eligible but below `min_score` (default 50): counted, not recommended |

Currency mismatch is never a silent pass: the budget is marked unknown, earns 0 points, and the match carries a caveat.

## 4. Ranking

- **Score** = 100 × Σ(weight × value) / Σ(weight) over the applicable dimensions.

  | Dimension | Default weight |
  |---|---:|
  | Location | 25 |
  | Budget | 25 |
  | Property type | 15 |
  | Bedrooms | 15 |
  | Amenities | 10 |
  | Availability | 10 |

- A dimension the lead gave **no preference** for is not applicable (nothing to match). A dimension the property **cannot be evaluated** on (currency mismatch, never verified) stays in the denominator with 0 points. Unknown never earns points.
- **Values:**
  - Location: 1 for the locality, 0.7 for the city only, 0 elsewhere.
  - Budget: 1 within; over budget falls linearly to 0 at 2 × flex; 0.9 below the stated minimum.
  - Property type: 1 for the same type, 0.6 for the same category.
  - Bedrooms: 1 exact, 0.7 for +1, 0.4 for +2 or more, 0.3 for fewer (soft only).
  - Amenities: the share listed.
  - Availability: 1 if verified within `freshness_days` (default 30), 0.5 if verified earlier, 0 if never.
- **Bands** (configurable): strong ≥ 85, good ≥ 70, partial ≥ `min_score`. A score is alignment with the stated preferences, never a guarantee of availability or suitability.
- **Tie-breakers** (deterministic): score; then availability (verified > stale > unverified); then `verified_at` (most recent first); then price closeness to the budget; then `updated_at`; then id.
- The shortlist holds at most `result_limit` (default 10). It is never padded: fewer good results means fewer rows.

## 5. Explanations

- **Template (always):** strengths, trade-offs and caveats from the record, e.g. "In Worli", "Within budget (INR 28,000,000 of 30,000,000)", "Parking not listed", "Availability not verified".
- **Claude (optional, asynchronous):** a short summary per recommended match. The input is the deterministic facts plus a sanitized description excerpt (phone numbers and emails removed); no lead PII, address or owner. The output is checked so that:
  - every match id belongs to the run;
  - every number in the text appears in that property's facts;
  - every quote appears in the description;
  - phrases like "perfect" / "guaranteed" and household-composition wording (fair housing) are rejected.

  Matching never waits for it; a failure leaves the template explanation.

## 6. Execution

```text
pg_cron property-matching-tick (SQL, every minute)
  ├─ outbox_claim('property_matching_agent', [lead.qualification.completed]) → enqueue run (idempotent per event) → ack
  └─ process due runs: lock lead → criteria → bounded candidates → eligibility → score → rank → persist → events
pg_cron → pg_net → Edge Function property-matching-worker (Vault shared secret)
  └─ claim runs whose explanation is pending → Claude → validate → attach
UI "Run matching" → RPC property_matching_request (idempotency key, rate limit) → enqueue run
```

- Runs for the same lead are serialized and stale pending runs are superseded.
- A failure rolls back and retries with backoff (2 → 4 → 8 → 16 min, then dead letter). A failed search is never recorded as "no matches".
- Empty inventory (`inventory_empty` warning) is distinguished from no eligible match.

## 7. Events

| Event | Consumer | When / dedupe |
|---|---|---|
| `property_matching.completed` | `follow_up_agent` | ≥ 1 recommendation persisted. Deduped on lead + fingerprint of (property, rank, price), so identical results never re-trigger follow-up |
| `property_matching.no_matches` | published | Per run |
| `property_matching.needs_information` | published | Per run |

Payload (ids only): `{event_type, schema_version: 1, organization_id, lead_id, matching_run_id, qualification_id, recommended_count, agent_run_id, correlation_id, occurred_at}`. The correlation id is carried from Agent 03's event. Agent 04 never messages anyone.

## 8. Security & privacy

- The org comes from the outbox row or the caller's membership. The lead, qualification and properties are all read with `organization_id` equal to the lead's org.
- RLS: runs and matches are readable with `leads.view`; there are no client writes. Actions require the lead-edit rule (`leads.edit_any`, or `leads.edit` on an assigned / unassigned lead). Settings need `settings.manage`.
- The read model returns only display-safe property fields (no address line, owner contact or internal notes).
- Matching uses only explicit property requirements; no personal or sensitive traits are inputs.

## 9. API & UI

- RPCs:
  - `property_matching_request(lead, key)`;
  - `lead_property_matches(lead)`: current run, recommendations with current listing state, history, run status, permissions;
  - `property_match_action(match, view | shortlist | reject | share | restore | request_review, note)`: shortlist and share **revalidate** the listing first (`STALE_MATCH`);
  - `property_matching_settings_save(org, rules)`;
  - service only: tick / process / explanation claim / attach.
- Triggers:
  - a listing leaving `active` invalidates its open recommendations; a price or currency change flags them;
  - booking a viewing marks the match `appointment_requested`.
- Lead drawer → **Property matches**: run status, counts, warnings, missing info, ranked cards (score, band, breakdown, strengths / trade-offs / caveats, availability), actions, history. The Agents page gets a live Agent 04 card.

---

## 10. What was built

| Piece | Where |
|---|---|
| Schema, criteria, engine, consumer, explanation endpoints, actions, settings, lifecycle triggers, crons | `supabase/migrations/20261025001300_property_matching_agent.sql` (applied live as version `20261025174719`) |
| Claude step: schema, prompt, fact-grounded validation | `supabase/functions/_shared/match-explanations.ts` |
| Worker that calls Claude (cron via pg_net, Vault shared secret) | `supabase/functions/property-matching-worker/index.ts` (deployed v1, `verify_jwt` off, checks its own secret) |
| UI: lead drawer **Property matches** tab (live mode); Agent 04 card on the AI agents page | `frontend/src/features/propertyMatches.tsx`, `leads.tsx`, `agentsLive.tsx`, `backend/live.ts` |
| Tests | `frontend/tests/db/property-matching-agent.test.ts` (16), `frontend/tests/match-explanations.test.ts` (4) |

Demo mode keeps the old client-side `matchProperties` ranking. Live mode shows only backend results.

### Criteria (what "hard" means here)

- CRM values a person entered are `confirmed` and become **hard** constraints.
- CRM values flagged in `ai_extracted_fields` are `ai_extracted` and stay **soft**, as do the qualification's `stated` (call) and `inferred` (model) values.
- The lead's `required_amenities` only ever affect ranking. A missing amenity is reported as "not listed for this property", not "does not have".
- Matching runs only when the intent is known and there is a location or a budget. Otherwise the result is `needs_more_information` with no shortlist.

### Defaults (`property_matching_settings.rules`)

- Weights:

  | Dimension | Weight |
  |---|---:|
  | Location | 25 |
  | Budget | 25 |
  | Property type | 15 |
  | Bedrooms | 15 |
  | Amenities | 10 |
  | Availability | 10 |

- Thresholds: `min_score` 50, `good_min` 70, `strong_min` 85.
- `result_limit` 10, `max_candidates` 1000, `budget_flex_pct` 10, `freshness_days` 30.
- `unverified_policy` `flag`, `location_flexible` false, `location_aliases` `{}`, `llm_explanations` true.

Saving rules through the RPC bumps the ruleset version, which every run records.

### Worked example

Live run, default rules: a buyer in Worli, CRM budget INR 30,000,000, apartment, 2 bedrooms.

| Listing | Result |
|---|---|
| Worli 2 BHK, INR 28,000,000, verified | **100**, strong |
| Worli 2 BHK, INR 29,000,000, never verified | **89**, strong: availability 0 points, plus an "Availability has not been verified" caveat |
| Worli, INR 45,000,000 | excluded `EXCEEDS_HARD_BUDGET` |
| Bandra | excluded `OUTSIDE_MANDATORY_LOCATION` |
| Rental | not retrieved (wrong transaction) |
| Another agency's identical listing | never visible |

## 11. Agent 05 contract

`property_matching.completed`:
- consumer `follow_up_agent`; stays `pending` until Agent 05 acks it;
- emitted only after the run and its recommendations are committed (same transaction, durable outbox);
- dedupe key `property_matching_completed:<lead>:md5(property:rank:price…)`, so unchanged results never re-trigger follow-up.

```json
{ "event_type": "property_matching.completed", "schema_version": 1, "organization_id": "…", "lead_id": "…",
  "matching_run_id": "…", "qualification_id": "…", "recommended_count": 2, "agent_run_id": "…",
  "correlation_id": "…", "occurred_at": "…" }
```

The correlation id is Agent 03's, which came from Agent 01's, so one id traces the lead from intake to follow-up.

`property_matching.no_matches` and `property_matching.needs_information` (the latter with the list of missing fields) are published informational events, not delivered to Agent 05.

To consume `property_matching.completed`, Agent 05 should:
1. Claim it with `outbox_claim('follow_up_agent', ['property_matching.completed'], n)`.
2. Read `lead_property_matches(lead)` or `property_matches` where `match_run_id` matches, skipping `rejected` / `invalidated`.
3. Revalidate each listing before using it (the shortlist / share actions show the pattern).
4. Check consent and suppression before any message, then ack.

## 12. Tests and results (2026-10-25)

| Check | Result |
|---|---|
| `npm test` (PGlite + vitest) | **154/154 pass**: 16 new matching DB tests, 4 new explanation-validator tests, all earlier suites |
| `npm run typecheck`, `npm run build` | pass |
| Live script against the hosted project (real cron chain, test workspaces E2E Realty A/B) | **15/15 pass** |
| Live function bodies vs migration file | all 24 identical (md5 of `prosrc`) |
| Cron → `property-matching-worker` | HTTP 200 (`{"explained":1}`) |
| Supabase advisors | only the expected "signed-in users can execute SECURITY DEFINER" warnings for the 4 new user RPCs, each of which checks permissions itself |
| Browser | The lead's Property matches tab showed the live run (status, counts, caveat banner, exclusions, ranked card with strengths and verification, Shared state). The Agents page showed the Agent 04 card live with real counts |

DB tests cover:
- **Eligibility and ranking:**
  - hard budget with the flex band, mandatory location, transaction type, availability status, property type category, bedrooms;
  - deterministic ranking and exact scores;
  - explanation text;
  - persistence, the Agent 05 event and correlation id;
  - no duplicate event for unchanged results.
- **People and lifecycle:**
  - display-safe read model; viewer vs editor permissions;
  - shortlist / reject (note limit) / view / share; decisions carried over to the next run;
  - price change flags, withdrawal invalidates, `STALE_MATCH`;
  - share revalidates and refreshes the snapshot, writes a `property_sent` activity and moves the pipeline;
  - revalidation invalidates a listing now over budget;
  - a booked viewing becomes `appointment_requested`; one review task.
- **Requirements and edge cases:**
  - rental matching; AI-extracted locations soft; aliases;
  - currency mismatch (unknown, 0 points, warning);
  - needs-more-information; sellers not applicable;
  - empty inventory vs no match, with one task;
  - `unverified_policy=exclude`; settings validation and permissions.
- **Orchestration:**
  - duplicate event redelivery creates one run;
  - a failed attempt keeps the previous result, retries, then succeeds;
  - supersede; manual idempotency, rate limit, closed leads.
- **Model step:**
  - claim exposes display facts only, with phone and email removed from descriptions; leasing;
  - valid summaries attached; foreign ids ignored; metadata filtered;
  - banned wording rejected; `not_configured`; 15-minute timeout.
- **Security:**
  - the other org cannot read, run, act or configure;
  - a forged cross-org outbox event is ignored;
  - no client writes; service-only functions; private helpers not callable.

Live checks cover:
- the Agent 03 backlog was consumed (empty inventory reported as `no_matches` + `inventory_empty`);
- full cron chain: intake → qualification → matching;
- ranking and exclusions; another agency's listing never visible; no address in the read model;
- Agent 05 event with ids only;
- the real worker recorded `not_configured`;
- shortlist; mark shared → activity + pipeline;
- withdrawal invalidates; `STALE_MATCH`;
- idempotent manual request;
- cross-tenant denial; users cannot tick or write scores;
- the worker rejects a wrong secret.

After the withdrawal, the manual re-run correctly dropped to 1 recommendation with status `completed`.

**Not executed:** a real Claude call (no `ANTHROPIC_API_KEY`). The validator and attach path are tested with hand-written model outputs.

## 13. Setup and operations

- **Nothing to start.**
  - `property-matching-tick` (SQL, every minute) consumes Agent 03's events and processes runs.
  - `property-matching-worker` (pg_net → Edge Function, every minute) handles summaries. Its URL and secret are in Vault (`property_matching_worker_url`, `property_matching_worker_secret`).
- **Claude summaries (optional):** set `ANTHROPIC_API_KEY` as an Edge Function secret (optionally `PROPERTY_MATCHING_MODEL`; default `claude-opus-5-5`). Without it, runs record `explanation_status = not_configured` and keep the template explanations.
- **Trigger matching:**
  - automatic when Agent 03 qualifies a lead (`qualified` / `high_intent`, or a human override to those);
  - manually from the lead's **Property matches** tab → **Run matching / Re-run matching**, or `property_matching_request(lead, key)`.
- **Configure rules** (owner/admin):

  ```sql
  select public.property_matching_settings_save('<org>', '{"budget_flex_pct": 5, "location_aliases": {"BKC": "Bandra Kurla Complex"}, "unverified_policy": "exclude"}'::jsonb);
  ```

  Re-run matching afterwards.
- **Revalidate:** shortlist and share re-check the current listing automatically. Listing withdrawals invalidate open recommendations immediately; price changes are flagged.
- **Inspect:**
  - Runs: `agent_runs` / `agent_run_steps` where `agent_id = 'property_matching_agent'` (`retry_scheduled` / `dead_letter` = failed attempts, with `error_message`).
  - Results: `property_match_runs` and `property_matches`.
  - Events: `outbox_events` where `event_type like 'property_matching.%'`.
- **Test without external services:** `npm test` (PGlite).

## 14. Limitations

- **Claude:** the summary step has never made a real call.
- **Rules:** no settings screen; use the RPC.
- **Inventory scope:** only the organization's own listings. The product has no partner sharing or external feed to authorize.
- **Locations:** matched on normalized locality / city text plus configured aliases. There are no coordinates, so no distance claims, nearby suggestions or "avoid these areas" lists (there is no data field for exclusions).
- **Requirements:** bathrooms, floor area, furnishing, parking or outdoor space, and new vs resale have no lead-side fields, so they are shown on cards but not scored. A "firm vs approximate" budget flag also has no field: a CRM budget is treated as approximate within `budget_flex_pct`, and 0 makes it strict.
- **Rent:** assumed monthly on both sides (the product has no price-period field).
- **Currency:** no FX source exists, so other currencies are never compared.
- **Re-runs:** new or changed inventory does not trigger re-matching for existing leads; use Re-run, or a later Agent 05/07 schedule. CRM edits re-match only through re-qualification (reviewer edits) or a manual run.
- **Agent 05:** not built, so `property_matching.completed` events wait as `pending`.
- **Test data:** labelled test listings (`E2E-…`) and leads remain in the E2E Realty A/B test workspaces.

## 15. Next step: Agent 05 (Follow-Up)

Build Agent 05 as the consumer of `property_matching.completed` (consumer `follow_up_agent`). For each event it should:
1. Re-read the lead, the contact's consent and suppression, the org's outbound switch and quiet hours, and the current recommendations.
2. Skip `rejected` / `invalidated` ones and revalidate the rest.
3. Draft a follow-up (shortlist summary or a viewing offer) for **human approval by default**. Send through the existing messaging integration only where the org has enabled autonomous follow-up and consent is `granted`.
4. Enforce frequency limits and a dedupe on (lead, run fingerprint), so repeated matching never produces duplicate messages.
5. Record `property_sent` activities, ack the event, and emit `follow_up.*` events for Agent 06 (viewing requests).
