# Phase 3 Agent Validation Matrix — Estate OS (staging)

Evidence comes from:
- `PHASE_3_E2E_TEST_REPORT.md` (staging run `MVPLOI1U`: 92 pass, 0 fail);
- the local suite (259 / 259).

**Statuses:**

| Status | Meaning |
|---|---|
| **PASS** | The agent's most important workflow was verified end to end on staging |
| **PARTIAL** | The deterministic core is verified on staging, but the agent's AI step or provider step is not |
| **BLOCKED** | It cannot run until a credential or provider exists |

No agent is marked PASS overall: each is an *AI* agent, and no AI step could be executed (no Anthropic key).

| Agent | Implemented / invocable | Inputs validated | Outputs persisted | Tenant isolation | Errors recoverable | External dependencies | Staging tests (IDs) | Result | Remaining blockers |
|---|---|---|---|---|---|---|---|---|---|
| **1 Lead Intake** | Yes. Signed webhook and `create_lead` | Yes: bad email → 422; bad signature → 401 | Yes: response matches the persisted lead in the right agency | Yes: B cannot see it; A's secret refused for B | Yes: replay → `duplicate_event`; same person → `repeat_enquiry`; 5× concurrent → 1 lead | Claude extraction: **not configured** (reported) | INT-01…10, ANL-01, ANL-03 | **PARTIAL**: deterministic intake **PASS**; AI free-text extraction **BLOCKED** | Anthropic key |
| **2 Voice Calling** | Functions deployed (old version, see drift) | Pre-call policy runs | No call created (correct) | B cannot run pre-call checks on A's lead | Forged webhook refused | **Retell not configured**; analysis not configured | VOI-01…05 | **BLOCKED**: no call or webhook can be verified. Policy and refusal paths PASS | Retell key, test agent, owned number; verify a real webhook |
| **3 Sales & Qualification** | Yes, via cron | Missing information → `needs_information` (QUA-04) | Qualification and lead status persisted (QUA-03) | B → NOT_FOUND (QUA-05) | Model absence recorded, not faked (QUA-02) | Claude: **not configured**. `qualification-worker` **redeployed** (pinned imports, zod 4) and returning 200 under cron | QUA-01…05 | **PARTIAL**: deterministic qualification **PASS** (`high_intent` 91 within about 20 s); AI analysis **BLOCKED** | Anthropic key |
| **4 Property Matching** | Yes, via the qualification event | Hard constraints applied | Ranked matches persisted | B's listing never matched (MAT-04); drawer query isolated (Phase 2 probe) | Empty result is honest (MAT-05) | Claude explanations: template fallback | MAT-01…05 | **PARTIAL**: deterministic matching **PASS** (excludes over budget, rental, other area, withdrawn); AI explanations **BLOCKED** | Anthropic key |
| **5 Follow-Up** | Yes, via fan-out | Policy and consent gates | Draft persisted, versioned | B cannot approve (FUP-06) | Idempotent request (FUP-04); approval never reported as delivered (FUP-05) | **No messaging provider**; Claude drafting: template fallback (FUP-03) | FUP-01…06 | **PARTIAL**: planning, grounding and approval **PASS**; delivery **NOT IMPLEMENTED**; AI drafting **BLOCKED** | Messaging provider (or a manual-send pilot); Anthropic key |
| **6 Appointment** | Yes (RPCs) | Notice and working hours enforced (FAIL-03) | Booking, history, version | B cannot cancel or book (APT-07) | Idempotent replay (APT-03); race → 1 win (APT-04); stale reschedule refused (APT-06) | **No calendar provider** (`calendar_provider: null`); assistant: `not_configured` | APT-01…07, CRM-01…02 | **PARTIAL**: internal scheduling **PASS** (org time zone Asia/Kolkata); calendar sync **NOT IMPLEMENTED**; AI assistant **BLOCKED** | Calendar adapter (or a pilot without sync); Anthropic key |
| **7 CRM & Data Intelligence** | Yes (cron + RPC) | Rule-based | Provenance recorded for webhook records (DQ-02) | B → NOT_FOUND (DQ-03) | Merges and reverts covered locally (16 DB tests) | Claude enrichment: `not_configured` (AI-01); guard live | DQ-01…03, AI-01 | **PARTIAL**: data-quality core **PASS**; enrichment **BLOCKED** | Anthropic key |
| **8 Sales Intelligence** | Yes (RPC); both AI functions **now deployed** | Unknown spec fields rejected (SI-03) | n/a (computed on request) | B → NOT_FOUND (SI-02); B unaffected by A's leads (ANL-02) | Model absence → 503 `not_configured` (AI-01) | Claude: not configured; guard live: auth, cross-tenant refusal, 10/h limit (AI-02…04) | SI-01…03, ANL-01…04, AI-01…04 | **PARTIAL**: KPI calculations **PASS** against independent counts (leads 12 = 12; appointments confirmed in window = metric); recommendations and the analyst **BLOCKED** | Anthropic key |

## Deployed versions on staging after Phase 3

| Function | Version | Matches the repository? |
|---|---|---|
| `sales-intelligence-recommend` | v1 (new) | Yes. The source retrieved from the platform matches the repository |
| `sales-analyst` | v1 (new) | Yes (same transcription process, deployed from the repository files) |
| `appointment-assistant` | v2 | Yes |
| `crm-enrichment` | v2 | Yes |
| `qualification-worker` | v2 (canary) | Yes. 200 to every cron call since the deploy |
| `lead-intake`, `voice-calls`, `voice-webhook`, `voice-worker`, `property-matching-worker`, `follow-up-worker`, `calendar-sync-worker` | unchanged | **No, known drift:** the deployed code imports `supabase-js@2` (floating) and `zod@3.24.1`; the repository pins `2.118.0` and `4.6.7`. Behaviour is unchanged and live-verified; redeploy them when a CLI deploy pipeline exists |
