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

## Operations (server-side, no browser needed)

| Job (pg_cron) | Runs | Does |
|---|---|---|
| `solara-reminders` | every 5 min | `queue_due_reminders()`: claims each confirmed appointment starting within 24 h (clinic time) and queues one reminder |
| `solara-prune` | 03:17 daily | `prune_operational_data()` |
| `solara-expire-info` | hourly | `expire_information()` |

**Appointments.** The database is the authority: `validate_booking` (trigger) checks closed days, doctor hours and slot grid, and confirmed leave on every
write; `bookings_no_overlap` and `bookings_doctor_slot_key` stop double booking under concurrency. Staff actions are single transactions:
`booking_create`, `booking_decide`, `booking_reschedule`, `booking_cancel`, `booking_set_status`. Statuses: requested → booked → completed | no_show, or cancelled.

**Patient messages.** `outbox.status`: `queued` → `processing` → `sent` (accepted by the provider) or `failed` (5 attempts, or 24 h unsent).
Sending needs these Edge Function secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Without them messages stay queued and are
reported as not sent; nothing is ever marked sent by the app. Vault secret `outbox_dispatch_url` holds this project's
`…/functions/v1/outbox-dispatch` URL; `outbox_dispatch_token` is generated by migration 0016. Delivery receipts (provider → "delivered") are not implemented.

**Sending is not switched on yet.** To turn it on: deploy `supabase/functions/outbox-dispatch` (JWT verification off; it checks its own token), set the
three Twilio secrets, enable the `pg_net` extension, store the function URL with `select vault.create_secret('<url>','outbox_dispatch_url')`, then
`select cron.schedule('solara-outbox','* * * * *','select public.outbox_kick()')`. Until then every patient text stays `queued` and turns `failed` after 24 h.

**WhatsApp (optional, per clinic).** Settings → Patient messages lets an owner or admin choose SMS (default) or WhatsApp; the choice is `organizations.message_channel` (migration 0037) and changes where appointment reminders, confirmations and cancellations go (other booking texts, such as reschedules, are sent as plain WhatsApp text). WhatsApp uses the Meta Cloud API with one platform-level sender. Edge Function secrets: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (a permanent system-user token), optional `WHATSAPP_REMINDER_TEMPLATE` (default `appointment_reminder`), `WHATSAPP_CONFIRMATION_TEMPLATE` (default `appointment_confirmation`), `WHATSAPP_CANCELLATION_TEMPLATE` (default `appointment_cancellation`) and `WHATSAPP_TEMPLATE_LANG` (default `en`). Reminders, confirmations and cancellations are clinic-initiated, so each needs its own Meta-approved Utility template (`appointment_reminder`, `appointment_confirmation`, `appointment_cancellation`) with exactly 3 body parameters, in order: {{1}} service, {{2}} doctor, {{3}} date and time (for example: "Reminder: your {{1}} appointment with {{2}} is on {{3}}.", "Confirmed: your {{1}} appointment with {{2}} is on {{3}}.", "Cancelled: your {{1}} appointment with {{2}} on {{3}}."). Free-text WhatsApp messages (anything that is not a template) only deliver inside the 24-hour customer-service window after the patient last wrote to the number, so the dispatcher uses these templates for the three. Without the two required secrets, WhatsApp rows stay queued and turn `failed` after 24 h, same as SMS.

**Insights** come from `insights_summary(org, days)`: counted in the database over the whole period, in the clinic's time zone.

**Changing the domain.** The app derives its address from where it is served. Update only: Supabase Auth → URL Configuration (Site URL and
redirect allow-list, used by password recovery), and the widget embed snippet on clinic websites.

**Known limits.** `staff-agent` and `llm-proxy` still bind to the caller's single clinic membership (the app refuses the assistant for multi-clinic
accounts until they accept an explicit clinic). The shared rate limiter fails open if the limiter itself errors. Per-service appointment length
is not modelled: every appointment is 30 minutes (`bookings.duration_min`).

`tests/db/operations.sql` checks all of the above on a database built by `tests/db/rebuild.sh` (runs in one transaction, rolled back).
