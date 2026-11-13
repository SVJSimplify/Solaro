# Tests

## Unit tests (no database)

    npm run test:tools

Tool-level tests with a fake database: malformed input, ambiguity, permissions, idempotency, retries, interrupted writes,
output verification and timeouts. These run anywhere Node 22 runs.

## Database tests (needs PostgreSQL 15 or later)

These run the real migrations and check row-level security as real users. They need an empty, disposable database
with the Supabase platform pieces the migrations depend on: the `anon`, `authenticated` and `service_role` roles,
`auth.users` and `auth.uid()`, a `vault` schema, and the `supabase_realtime` publication. Never point them at production.

    export TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/solara_test
    # 1. create the database, apply the platform stub, then every migration in order
    # 2. then run:
    npm run test:db
    # Backfill tests need a database built only up to migration 0007, then 0008 applied by the test:
    npm run test:backfill

The local harness used during development is documented in the delivery report.
Deno type-checking of the shared modules: `deno check supabase/functions/_shared/tools/*.js`.
