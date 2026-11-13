# Solara (clinic AI front desk) — Vite + React + Supabase

    npm install
    npm run dev      # http://localhost:5173
    npm run build    # dist/

With no `.env`, the app runs in browser-only demo mode (`localStorage`, no AI). Set the two frontend variables below to go live.

## Architecture
- **Central tool registry** (`supabase/functions/_shared/tools/`): every tool is defined once (`defineTool`) with its schema, minimum role, surface (`staff` or `front`) and patient-data class. `buildRegistry()` assembles them; `modelToolsFor(registry,{role,surface})` gives the model only the tools that role/surface may use.
- **Executor** (`executor.js`): the only way a tool runs. Pipeline: registry lookup → schema → auth → membership/role/surface → org time zone → patient-info guard → normalise → idempotency claim → run (retry/timeout) → output check → audit record. `loop.js` (`runToolLoop`) drives the model↔tool conversation through it.
- **Supabase adapter** (`supabaseAdapter.js`): the tools' only database access. It wraps a supabase-js client that carries the **caller's JWT**, so row-level security applies. It never uses a service-role key.
- **staff-agent Edge Function** (`supabase/functions/staff-agent`): the staff/owner/doctor assistant. It verifies the bearer token, resolves the caller's org and role from `members`, builds the role's tool list from the registry, and runs the loop. The service-role client is used only to read the clinic's model key and consume the daily AI allowance (`orgProvider`). Called from the app via `staffAgent()` in `src/lib/llm.js` (Setup chat).
- **Front desk** (customer chat): `src/lib/frontAgent.js` uses the same registry with `surface:'front'`. `widget-chat` serves the public widget; `llm-proxy` proxies model calls for the app.
- **Information model** (migrations 0008–0011): `business_entities`, `business_facts`, `schedule_rules`, `schedule_exceptions`, `tool_executions`, one append-only audit trail (`audit_events`; legacy `audit` is a compatibility view), and the DB function `apply_information_item` (atomic per item, protects confirmed data, detects duplicates/contradictions, refuses patient info).
- **Roles**: doctor < staff < admin < owner. Doctors can read permitted information only (no conversations, bookings, alerts or outbox). Staff can record tentative information but cannot overwrite confirmed information.
- **Booking limitation**: the booking engine still reads the legacy `doctors` table. Conversational schedule information does **not** control availability. Legacy `doctors`/`closures` changes sync one way into the information tables.

## Configuration
**Frontend** (`.env`, copy from `.env.example`; public values only):

    VITE_SUPABASE_URL=https://<project-ref>.supabase.co
    VITE_SUPABASE_ANON_KEY=<anon or publishable key>

**Edge Function secrets** (`supabase secrets set NAME=value`):

| Name | Required | Purpose |
|---|---|---|
| `LLM_BASE_URL` | yes | OpenAI-compatible chat-completions endpoint the model is called on |
| `LLM_MODEL` | no | default model when the clinic has none set |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase; do not set them. Each clinic's model key lives in Vault and is set by a platform admin (`admin_set_model_key`). Never put a service-role key or model key in `.env`, the frontend or git.

## Deploy
Migrations (apply in order; production already has 0001–0011; do not re-apply):

    supabase link --project-ref <ref>
    supabase db push

Functions (JWT verification is on by default; do **not** pass `--no-verify-jwt`):

    supabase secrets set LLM_BASE_URL=<endpoint>
    supabase functions deploy staff-agent
    supabase functions deploy llm-proxy widget-chat   # only if changed

Frontend: `npm run build`, host `dist/` statically with all paths rewritten to `index.html`.

## Tests
    npm run test:tools      # unit tests, fake DB, no setup
    npm run test:db         # real migrations + RLS on local PostgreSQL 15+; see tests/README.md
    npm run test:backfill   # DB built only to before 0008 (see tests/README.md)

These run on local PostgreSQL with a Supabase stand-in, not on a real Supabase project. They do not prove the adapter works through PostgREST or that the deployed function works; use the checklist in `PHASE_3_STABILIZATION_REPORT.md`.
