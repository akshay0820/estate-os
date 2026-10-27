# Pilot Review — [Agency name] — [period]

Fill this in from recorded evidence only. Where a value is unavailable, say so and say why. Attach the Pilot operations export, the incident log and the feedback log.

## 1. Executive summary

- Overall result in three sentences.
- **Recommendation (pick one):** Expand / Continue at current stage / Pause / Stop.

## 2. Pilot scope

| Item | Value |
|---|---|
| Period | |
| Stage reached (0–3) | |
| Workflows included | |
| Workflows excluded | |

## 3. Enabled agents

| Agent | Stage | Changes this period (from the audit log) |
|---|---|---|
| 1 Lead intake | | |
| 2 Voice | | |
| 3 Qualification | | |
| 4 Matching | | |
| 5 Follow-up | | |
| 6 Appointment | | |
| 7 CRM & data | | |
| 8 Sales intelligence | | |

## 4. Usage summary

From Pilot operations for the period:
- leads created;
- webhooks processed and rejected;
- agent runs;
- follow-ups planned, approved and sent;
- appointments confirmed;
- AI requests.

## 5. Business outcome comparison

| Metric | Baseline (source, period) | Pilot (source, period) | Difference | Sample size | Confidence / caveats |
|---|---|---|---|---|---|
| Lead response time | | | | | |
| Qualification rate | | | | | |
| Lead → appointment | | | | | |
| Staff minutes per lead (time study) | | | | | |

## 6. Reliability results

- Run failures (`dead_letter`, `invalid`);
- cron or worker non-200s;
- held runs;
- event backlog peaks;
- the explanation of each failure.

## 7. Agent quality

| Agent | Agreement / acceptance | Corrections | Notable errors |
|---|---|---|---|
| 3 Qualification | | | |
| 4 Matching | | | |
| 5 Follow-up | | | |
| 7 CRM & data | | | |
| 8 Sales intelligence | | | |

## 8. Customer feedback

Summary by category: bug, reliability, data quality, usability, missing integration, training, feature request, commercial. Include the top 3 verbatim comments, with permission.

## 9. Cost analysis

| Cost | Amount | Measured / estimated / unknown | Source |
|---|---|---|---|
| AI model usage | | | Anthropic console |
| Hosting | | | |
| Database | | | |
| Support hours | | | |
| Cost per lead processed | | | |

Do not present activity as savings.

## 10. Incidents

| ID | SEV | Date | Summary | Containment | Root cause | Status |
|---|---|---|---|---|---|---|

## 11. Limitations

What the system did not do (for example: no message delivery, no calendar sync, AI steps off) and how the agency compensated.

## 12. Lessons learned

## 13. Recommended product changes

Each change with:
- priority (security > integrity > reliability > primary workflow > value > reuse > cost);
- whether it is specific to this agency or general.

## 14. Recommendation and conditions

- The recommendation.
- The exact conditions for the next stage.
- Decision owners: BlazeReach — *[role]*; agency — *[role]*.
