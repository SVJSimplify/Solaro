# Phase 3 Stabilization Report

**Recommendation: NOT READY FOR USER TESTING.** The Supabase adapter, `staff-agent` and real model tool calling have never run against the real Supabase API. This sandbox cannot reach `*.supabase.co` (the egress proxy returns 403), and the tool-download classifier denied fetching PostgREST/Deno. Passing local tests do not establish production readiness.

## 1. Bugs discovered
1. `staff-agent` had no model/loop timeout. A slow provider would hang the request until the platform killed it.
2. `staff-agent` did not reject a missing bearer token before calling Supabase, and did not check required env vars (a misconfigured deploy would fail with an opaque 500).
3. `staff-agent` computed "today" in UTC instead of the clinic timezone. A clinic in `Asia/Kolkata` would get the wrong date for roughly the first 5.5 hours of its day.
4. The test clinic's `organizations.timezone` was `UTC`.
5. Migration-history discrepancy: production has `0004_bookings_per_doctor_unique`, which is absent from the repo (see §4).
6. The SQL `contains_patient_info()` in production still matches UUID/ISO-date digits. The JS guard strips these first, so the effect is limited to direct DB-function calls.
7. Unverified, not proven bugs: the PostgREST `.or()` filters, the `listFacts` embed, and the `ilike` escape. They run correctly on the local pg adapter but never against real PostgREST.

## 2. Bugs fixed
- Items 1–3 (staff-agent hardening, below).
- Item 4: timezone set for the test org only.
- Item 5: documented, no change needed.

## 3. Files changed (this stabilization turn)
- `supabase/functions/staff-agent/index.ts`:
  - 401 when no token is sent.
  - 500 "Server not configured" when env vars are missing.
  - 50s timeout around the tool loop, mapped to 504.
  - Provider/other failures map to a generic 502 with no key or detail leakage.
  - "Today" is now computed in the org timezone.

Earlier Phase 3 files are unchanged this turn.

## 4. Database changes
- Production, data only: `organizations.timezone = 'Asia/Kolkata'` for `82f73c90-61e5-465c-9c56-42be4d1ac8ac` ("Test Bussiness", the only org). No other rows were touched.
- No new migrations. No resets, drops, or rewritten history.
- **0004 discrepancy:** production's migration list has `0004_bookings_per_doctor_unique` and `0004_message_meta`. The repo's `0003_full_backend.sql` already creates `bookings_doctor_slot_key` (`unique (doctor_id, starts_at) where status <> 'cancelled' and doctor_id is not null`). Production's index definition is identical, so the schema is equivalent. The only difference is history naming. Do not re-apply it. A no-op placeholder file could be added later if the history needs to match.
- Production read-only checks:
  - All public tables have RLS enabled.
  - The only anon-executable SECURITY DEFINER function is `widget_start`, which is intentional (the customer widget).
  - Bookings: 0 rows. `audit_events`: 1 row. `tool_executions`: 0 rows.
- The full column/policy/constraint diff against local could not be run. The large query returned Bad Gateway from the MCP, so only the bookings objects were compared directly.

## 5. Tests executed (exact)
| Suite | Result | Backend |
|---|---|---|
| `tests/tools/unit.test.mjs` | 64/64 pass | Mocks (fake DB) |
| `tests/db/information.test.mjs` + `tools.test.mjs` | 39/39 pass | Local PostgreSQL 16 with a Supabase stand-in (`shim.sql`), real migrations, real RLS as real roles. Not real Supabase. |
| `tests/db/backfill.test.mjs` | 5/5 pass | Local PostgreSQL, DB built to before 0008 (`STOP_BEFORE=0007_admin_list_override.sql`) |
| `vite build` | OK | n/a |

## 6. Real Supabase vs mocks
- **Real Supabase:** only the read-only/one-row `execute_sql` and `list_migrations` checks above, via the MCP.
- **Not run against real Supabase (blocked):**
  - Supabase adapter through PostgREST.
  - Authenticated-session RLS through the API.
  - Cross-org isolation through the API.
  - Tool execution and extraction end to end.
  - `staff-agent`.
- Role and tenant isolation is verified only on local PostgreSQL with identical migrations and RLS.
- No synthetic data was written to production.

## 7. Real model tool calling
**Not verified.** It needs the deployed function and an org model key, and the sandbox cannot call `supabase.co`.

## 8. staff-agent deployed?
**No.** It was not deployed, because deploying code that has never run against the real API is unclear-risk. Production currently has no `staff-agent` function.

## 9. Frontend deployed?
**No.** It builds, but it calls `staffAgent`, which does not exist in production yet.

## 10. Remaining limitations
- **Booking engine reads the legacy `doctors` table.** Conversational schedule info does not control availability.
- What happens when conversational schedule info changes:
  - Legacy `doctors` and `closures` changes sync into `business_*` information via triggers (one-way).
  - Conversational `weekly_hours` and `leave` changes are recorded in `schedule_rules`, `schedule_exceptions` and audit, and are visible to staff tools.
  - They do not change what the front desk can book.
- Booking regression is covered only by the ported front tools in unit tests and by the local DB tests (per-doctor unique slot index intact). Real bookings were not exercised.
- All orgs default to `timezone='UTC'`. Only the test org is set.
- Deno type-check is unavailable here.

## 11. Production risks
- First real-API run of the adapter may expose PostgREST filter or embed issues (`.or()` strings, `business_entities(name)` embed, `ilike` escape).
- `audit` is now a compatibility view; old-app inserts go through an INSTEAD OF trigger (tested locally only).
- `staff_all` policies replaced `tenant_all` on five tables. A doctor-role user is blocked from them by design (tested locally).
- `staff-agent` must be deployed with JWT verification on (default; no `--no-verify-jwt`). The function also validates the token itself via `auth.getUser`. If the platform's JWT check rejects a valid session token (new-style signing keys), report it; do not disable verification.

## 12. Manual testing checklist (after deploying `staff-agent`)
1. Sign in as the owner. In Setup chat: "Dr Sharma works Mon–Fri 9–5". Expect confirmed hours, plus an audit event.
2. "Dr Sharma might be unavailable next Tuesday". Expect tentative, not confirmed leave. The source quote must be the user's words.
3. Repeat message 1. Expect "duplicate", no new row.
4. "Dr Sharma is on leave next Tuesday" as staff. Expect tentative only; staff cannot confirm.
5. Ambiguous doctor/date. Expect a clarification question.
6. Sign in as a doctor. They should see schedules but not conversations, bookings, alerts or the outbox.
7. Customer widget: book an appointment, then cancel your own test booking. Expect the per-doctor slot rule to hold.
8. With no/expired token, call `staff-agent`. Expect 401.
9. With a bad or missing model key, expect a 4xx/5xx with a clear message and no key leaked.
10. Confirm the Activity page shows audit events and the realtime feed updates.

## 13. Final recommendation (superseded by §18)
**NOT READY FOR USER TESTING.** Next step: with your approval, deploy `staff-agent` (`verify_jwt` on), then run the checklist above on the test org. Fix any PostgREST issues found before deploying the frontend.

## 14. Reconciliation (verified against the repository ZIP `solara-phase3.zip`, not memory)
- Stale files: `src/lib/agentLoop.js`, `frontTools.js`, `setupTools.js`, `setupPrompt.js` are **absent** from `solara-phase3.zip` (checked with `unzip -l`) and from the working tree. No import, dynamic import or test references them; the only mentions are comments in `supabase/functions/_shared/tools/front.js`. An earlier uploaded ZIP (`solario.zip`) still contained them. It was not the delivered ZIP and was not used; the same four files were unreferenced there too (grep over `src`, `tests`, `supabase`), so deleting them is safe in either copy.
- `.gitignore` now ignores `.env`, `.env.*`, `*.pem`, `*.key`, `supabase/.temp`, `supabase/.branches`, and keeps `.env.example` (verified with `git status --ignored` on a scratch repo: `.env`, `.env.local`, `.env.production` ignored; `.env.example` tracked). Before: only `.env` and `.env.local`.
- Secret scan of the repo and ZIP: no JWTs, `sk-`, `sb_secret`, `sb_publishable` or Google-style keys; no `.env` in `solara-phase3.zip`, only `.env.example` with empty values. `service_role` appears only in migrations, tests and the local DB stand-in (role names), never as a value; no client code uses it. The server-side function code reads it from `Deno.env`.
- The uploaded `solario.zip` contains a real `.env` (frontend URL plus a publishable key). Publishable keys are public by design, but that file should not be distributed; rotate nothing unless it held anything else (it did not: two keys only).
- README rewritten for the current architecture. The old `assistant` function, "paste 0001 into the SQL editor" and `ANTHROPIC_API_KEY` instructions are gone.
- `supabase/functions/assistant` and `src/lib/assistant.js` are not referenced by the app (`widget-chat`, `llm-proxy`, `staff-agent` are the only functions the frontend calls). They are **retained**, not removed: outside this scope and not proven unused in production (the widget/channel integrations may call it). Decide in a later cleanup.

## 15. Files removed / retained
| File | Status | Why |
|---|---|---|
| `src/lib/agentLoop.js`, `frontTools.js`, `setupTools.js`, `setupPrompt.js` | Already removed in `solara-phase3.zip` | Replaced by `_shared/tools/loop.js`, `front.js`, `prompt.js`; zero references |
| `src/lib/assistant.js`, `supabase/functions/assistant/` | Retained | Not referenced by the app but not proven dead; out of scope |
| `.env` | Not in delivered ZIP | Local secrets file |
| `.env.example`, `.gitignore`, `README.md` | Updated | Items 2–4 |

## 16. Deployment guide: staff-agent with JWT verification on
Preconditions: Supabase CLI logged in; migrations 0001–0011 already in production (do not re-apply); an org model key set via `admin_set_model_key`.
1. `supabase link --project-ref wqhxpfzbvtkdwzehddjr`
2. `supabase secrets set LLM_BASE_URL=<OpenAI-compatible endpoint>` (and optionally `LLM_MODEL`). `supabase secrets list` should show the name, never the value.
3. `supabase functions deploy staff-agent` (verification stays on).
4. Confirm: `supabase functions list` shows `staff-agent` ACTIVE; in the dashboard the function's "Verify JWT" is on.
5. Unauthenticated check: POST with no `Authorization` header → 401 (platform) and with the anon key as bearer → 401 `Sign in required`. Neither may reach the model.
6. Authenticated tests, test org only, synthetic data, signed in as owner (then staff, then doctor):
   - owner: "Dr Sharma works Mon–Fri 9–5" → confirmed, audit event, source quote is your words
   - owner: "Dr Sharma might be unavailable next Tuesday" → tentative, never confirmed leave
   - repeat the first message → duplicate, no new row
   - staff: cannot confirm or overwrite confirmed info
   - doctor: gets only read tools; no conversations/bookings/alerts/outbox
   - a message containing patient details → refused
   - clinic without a model key → 402 with a clear message; no key in any response
7. Check `supabase functions logs staff-agent` for errors; check `audit_events` and `tool_executions` rows for the test org.
8. Booking regression in the customer widget on a synthetic booking; do not touch real bookings.
9. Only after all pass: deploy the frontend. Rollback for the function: redeploy the previous version, or delete `staff-agent` (nothing else depends on it until the frontend ships).

## 17. Deployment checklist
- [ ] Working tree is `solara-phase3.zip` contents (no stale files, no `.env`)
- [ ] `npm run test:tools`, `test:db`, `test:backfill`, `npm run build` pass on the commit being deployed
- [ ] `LLM_BASE_URL` secret set
- [ ] Test org has a model key and `timezone = Asia/Kolkata` (done)
- [ ] `staff-agent` deployed with Verify JWT on
- [ ] Unauthenticated calls rejected
- [ ] Owner / staff / doctor tests from §16 pass
- [ ] Cross-org: a second synthetic org cannot read or write the first org's data through the function
- [ ] Booking regression on synthetic data
- [ ] Frontend deployed last, only if everything above passed

## 18. Final recommendation
- **Not deployed by this task.** The Supabase connection was also unavailable while reconciling, so production state was not re-checked; the earlier verified state (no `staff-agent` deployed) is unchanged as far as is known.
- **staff-agent deployment: GO, conditionally.** The function is additive, called by nothing until the frontend ships, and fails closed (401 / 403 / 402 / 429 / 502). It can be deployed and tested in isolation on the test org with low production risk. It is still unverified against real PostgREST, so a first-run failure is expected to surface as a 502, not data damage.
- **Frontend deployment: NO-GO** until §16 steps 5–8 pass.
- **Overall: NOT READY FOR USER TESTING** until the authenticated tests have run for real.
