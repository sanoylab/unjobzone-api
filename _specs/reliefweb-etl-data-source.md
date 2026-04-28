# ReliefWeb ETL Data Source

## Summary

Add a new daily ETL pipeline that pulls job postings from the public ReliefWeb API
(`https://api.reliefweb.int/v2/jobs`), transforms them into the existing
`job_vacancies` schema, and upserts them into Postgres. The feature is purely
additive: no existing scrapers, schedules, schema, controllers, or social-media
posting behavior change.

## Problem / Goal

UNJobZone currently aggregates jobs from twelve UN-agency sources. ReliefWeb
hosts a much broader humanitarian-jobs feed (UN agencies, NGOs, INGOs, Red
Cross/Red Crescent, etc.) that is not represented today. We want to ingest up
to 1,000 ReliefWeb postings daily so they become searchable in the same
listings surface as native sources, without altering the database schema or
any existing user-facing behavior.

## Scope

In scope:

- New ETL module `src/etl/etl-reliefweb.js` exporting a single function
  `fetchAndProcessReliefwebJobVacancies()` that returns
  `{ success, processedCount, successCount, errorCount, error? }` to match the
  contract `runEtl()` already expects.
- Use the ReliefWeb v2 jobs endpoint with `appname`, `preset=latest`,
  `profile=full`, paginated by `limit` and `offset`, capped at 1,000 records
  per run.
- Field-by-field transformation from the ReliefWeb response shape into the
  current `job_vacancies` columns.
- Reuse of existing helpers: `acquireETLLock`, `releaseETLLock`,
  `logETLStatus`, `getJobCount`, `getOrganizationId`, `upsertJobVacancy`,
  `validateJobData`, `cleanupExpiredAndDuplicateJobs`. No changes to those.
- A new daily `node-cron` schedule in `src/app.js` that runs the ReliefWeb ETL
  alone (independent of the twice-daily multi-agency `runEtl()`).
- New environment variable `RELIEFWEB_APPNAME` (the ReliefWeb-issued
  `appname` token) read from `.env`. The endpoint URL is otherwise public
  and unauthenticated.
- Redis cache invalidation (`jobs:*` keys) after a successful ReliefWeb run,
  matching the pattern other agencies use.
- ETL status logging into the existing `etl_status` table under
  `organization_name = 'RELIEFWEB'`, so the existing dashboard surfaces the
  new source automatically.
- One row in the `organization` table for ReliefWeb so `getOrganizationId`
  resolves cleanly when the per-job source list cannot be matched. (Insert is
  data-only; no schema change.)
- Documentation: add the new env var to `README.md`'s env section and a brief
  note to `CLAUDE.md` describing the new agency and its standalone schedule.

Out of scope:

- Any change to `job_vacancies`, `etl_status`, or other table definitions.
- Any change to existing agency scrapers, the `etlJobs` array order, the 6 AM
  / 6 PM full-ETL schedule, social-media posting, blog generation, the API
  surface, the frontend, or controllers.
- Caching strategy changes beyond invalidating `jobs:*` post-run.
- Rate limiting, throttling, or retry-policy changes to other ETLs.
- Backfill of historical ReliefWeb postings beyond the 1,000-row preset cap.
- Frontend UI changes — ReliefWeb jobs surface via existing list/filter
  endpoints once `data_source = 'reliefweb'` rows exist.
- Adding ReliefWeb to the social-media posting categories. Job-network cron
  jobs continue to filter on the existing `jn` values; ReliefWeb rows will
  participate only if the transformed `jn` happens to match an existing
  category.
- Authentication, OAuth, paid-tier API access, or webhook ingestion.
- ReliefWeb's other resource types (reports, disasters, training, etc.).

## Users / Roles

- **End users (job seekers)** — see additional postings in existing job
  listing endpoints; behavior is unchanged otherwise.
- **Operations / dashboard viewer** — sees a new `RELIEFWEB` row in the ETL
  status dashboard alongside the existing twelve.
- **Backend developer** — runs the new ETL ad hoc via a standalone script
  (`node run-reliefweb-etl.js`) for testing, mirroring the existing
  `run-unicef-etl.js` / `run-unops-etl.js` pattern.

## User Flows

### Flow 1 — Scheduled daily ingestion

1. Cron fires once a day (server timezone) at the chosen daily slot.
2. Handler acquires the `RELIEFWEB` ETL lock via `acquireETLLock`. If denied
   (another ETL running), the run is skipped with a log line and a `failed`
   status row noting the reason.
3. Handler logs `running` status, then calls
   `fetchAndProcessReliefwebJobVacancies()`.
4. ETL fetches up to 1,000 jobs from ReliefWeb in pages, transforms each,
   upserts via `upsertJobVacancy`, and tallies counters.
5. On success: log `success` with counts and `jobs_in_db`, release the lock,
   flush `jobs:*` Redis keys, run `cleanupExpiredAndDuplicateJobs()`.
6. On failure: log `failed` with the error message and release the lock.

### Flow 2 — Ad hoc developer run

1. Developer runs `node run-reliefweb-etl.js` from the repo root.
2. Script invokes the same `fetchAndProcessReliefwebJobVacancies()` and
   prints the same summary the cron path produces.
3. No lock contention with the multi-agency `runEtl()` because the standalone
   script also goes through `acquireETLLock`.

### Flow 3 — End-user search

1. User loads the jobs listing on the frontend.
2. The existing `/api/v1/jobs*` endpoints return both legacy and ReliefWeb
   rows; ReliefWeb rows are identified by `data_source = 'reliefweb'`.
3. No frontend change is required for ReliefWeb postings to appear.

## Functional Requirements

### F1. ETL module shape

- File: `src/etl/etl-reliefweb.js`.
- Exports `fetchAndProcessReliefwebJobVacancies()`.
- Return object: `{ success: boolean, processedCount: number,
  successCount: number, errorCount: number, error?: string }` — matches what
  `runEtl()` already expects from agency modules in `app.js`.
- Module owns its own `pg` client lifecycle (connect / end) the same way
  existing agency modules do.

### F2. ReliefWeb fetch behavior

- Base URL: `https://api.reliefweb.int/v2/jobs`.
- Query params: `appname=<RELIEFWEB_APPNAME>`, `preset=latest`,
  `profile=full`, `limit=<page size>`, `offset=<page offset>`.
- Pagination: page through results, accumulating up to `MAX_JOBS = 1000`
  total. Stop when either the API reports no more results or the cap is hit.
- Recommended page size: `limit=200` (well within ReliefWeb's per-call cap;
  five calls cover the 1,000 ceiling).
- Network reliability: use the existing `safeApiCall` helper from
  `src/etl/shared.js` (retries with exponential backoff, 30 s timeout).

### F3. Field transformation

For each ReliefWeb item under `data[].fields`, populate `job_vacancies`
columns as follows:

| Target column         | Source                                                                 | Notes |
| --------------------- | ---------------------------------------------------------------------- | ----- |
| `job_id`              | `data[].id` (numeric, stringified)                                     | Required |
| `language`            | `'EN'` (constant)                                                      | ReliefWeb listings are mixed-language; treat as EN by default to stay aligned with current data. |
| `category_code`       | `fields.career_categories[0].name` if present, else `''`               | |
| `job_title`           | `fields.title`                                                         | Required; truncate to 500 chars (validator already enforces). |
| `job_code_title`      | `''`                                                                   | No analog exists in ReliefWeb. |
| `job_description`     | `fields.body-html` if present, else `fields.body`                      | Strip null-byte/control chars; do not re-render Markdown. |
| `job_family_code`     | `fields.theme[0].name` if present, else `''`                           | |
| `job_level`           | `fields.experience[0].name` if present, else `''`                      | ReliefWeb experience labels (`'0-2 years'`, etc.) used verbatim. |
| `duty_station`        | Concatenation of `fields.city[*].name` and `fields.country[*].name`    | E.g. `"Geneva, Switzerland"`. Empty string if neither present. |
| `recruitment_type`    | `fields.type[0].name` if present, else `''`                            | E.g. `"Job"`, `"Consultancy"`. |
| `start_date`          | `fields.date.created` parsed as Date                                   | |
| `end_date`            | `fields.date.closing` parsed as Date; if missing, leave `NULL`         | |
| `dept`                | `fields.source[0].name` if present, else `'ReliefWeb'`                 | The hiring org name. |
| `total_count`         | `null`                                                                 | |
| `jn`                  | `fields.career_categories[0].name` if present, else `''`               | Job network. |
| `jf`                  | `fields.theme[0].name` if present, else `''`                           | Job family. |
| `jc`                  | `''`                                                                   | |
| `jl`                  | `fields.experience[0].name` if present, else `''`                      | Job level. |
| `data_source`         | `'reliefweb'` (lowercase)                                              | Matches existing convention. |
| `organization_id`     | Resolved per F4                                                        | |
| `apply_link`          | `fields.url_alias` if present, else `fields.url`                       | Public posting URL. |
| `created`             | `NOW()` (set by the upsert helper)                                     | |

### F4. Organization resolution

- For each job, take `fields.source[0].name` (or `shortname` if name is
  missing) and pass it through `getOrganizationId(name)`. The helper already
  matches against the `organization` table and falls back to id `128` (UN
  catch-all) on miss.
- Insert one new row in `organization` for "ReliefWeb" itself so the source
  itself is a queryable organization. This is a data insert, not a schema
  change; idempotent via `ON CONFLICT DO NOTHING` on whatever existing
  unique constraint the table already has.

### F5. Persistence

- Each transformed job is passed through `upsertJobVacancy` so the existing
  `(job_id, data_source, organization_id)` unique constraint deduplicates
  re-runs and same-day repeats.
- All inserts/updates flow through one DB client opened by the module; the
  module is responsible for closing it in a `finally` block (matches
  existing agency modules).

### F6. Schedule and orchestration

- Add a single `node-cron` registration in `src/app.js`:
  `cron.schedule('0 5 * * *', ...)` — 5:00 AM server time, ahead of the
  existing 6:00 AM full ETL so locks don't collide.
- The handler mirrors the per-agency block already inside `runEtl()`: lock,
  log running, invoke the ETL, log success/failure with counts, release
  lock, flush Redis, run `cleanupExpiredAndDuplicateJobs()`.
- Do **not** add ReliefWeb to the `etlJobs` array inside `runEtl()`. Keeping
  it on its own cron isolates it from the existing twice-daily run and lets
  ops disable it independently.
- The startup `runEtl()` call in `app.listen` is left untouched; ReliefWeb
  fires on its own daily schedule, not at server start.

### F7. Configuration

- Read `process.env.RELIEFWEB_APPNAME` at module load. If missing, the ETL
  function returns `{ success: false, error: 'RELIEFWEB_APPNAME not set' }`
  without making a network call.
- Document `RELIEFWEB_APPNAME` in `README.md` and in the env list inside
  `CLAUDE.md`.

### F8. Observability

- Same `console.log` banners as existing modules (e.g. `"==== ReliefWeb ETL
  started ===="`).
- All status transitions written through `logETLStatus` so the existing
  `/api/v1/etl` dashboard endpoints surface ReliefWeb without code changes
  on the dashboard side.
- Sentry: errors thrown out of the ETL function are already captured by the
  global handlers; no module-specific Sentry wiring needed.

### F9. Standalone runner

- Add `run-reliefweb-etl.js` at the repo root, mirroring `run-unicef-etl.js`
  / `run-unops-etl.js`. It loads `.env`, calls
  `fetchAndProcessReliefwebJobVacancies()`, prints the summary, and exits.

## Validation Rules

- `job_id` must be present and non-empty (existing `validateJobData`
  enforcement). Skip and increment `errorCount` if missing.
- `job_title` must be present and ≤ 500 chars. Skip if missing; truncate is
  not required because the validator already rejects over-length.
- `start_date` and `end_date`, when present, must parse to valid Dates.
  Invalid date strings cause the row to be skipped with an error counter
  bump.
- `data_source` is hard-coded to `'reliefweb'`; the validator already
  rejects rows missing it.
- `RELIEFWEB_APPNAME` must be a non-empty string at module entry; otherwise
  the run returns failure without partial work.

## Edge Cases

- **ReliefWeb returns < 1,000 results.** Stop pagination when a page returns
  fewer items than requested or `data` is empty.
- **ReliefWeb 5xx or timeout mid-pagination.** `safeApiCall` retries with
  exponential backoff up to three attempts per page. If a page still fails,
  abort the run, return `{ success: false, error: ... }`, and let
  `etl_status` carry the message. Already-upserted pages persist; the next
  day's run reconciles via upsert.
- **Same job appears in multiple consecutive runs.** The unique constraint
  on `(job_id, data_source, organization_id)` plus the upsert path makes
  this a no-op update, refreshing `created` timestamp only.
- **Same posting cross-listed under multiple orgs in `fields.source[]`.**
  We resolve `organization_id` from `source[0]` only, so the same posting
  always lands on the same row. We do not create per-source duplicates.
- **Job has no closing date.** `end_date` is `NULL`; the existing
  `cleanupExpiredAndDuplicateJobs` job uses `end_date < NOW()`, so
  null-dated rows are never auto-expired. They will linger until ReliefWeb
  drops them from the feed; acceptable for now and explicitly out of scope.
- **HTML in `body-html`.** Stored as-is. The frontend already renders
  HTML-bearing descriptions for other sources; no extra sanitization
  needed beyond the existing controller path.
- **`fields.source` missing or empty.** Default `dept = 'ReliefWeb'`,
  `organization_id = getOrganizationId('ReliefWeb')` (will resolve to the
  ReliefWeb org row created in F4, or id 128 as a final fallback).
- **Lock contention** with a manual `runEtl()` triggered by a server
  restart at the wrong moment. `acquireETLLock` already handles this — the
  ReliefWeb run is skipped and logged as failed-due-to-lock, retried on the
  next day's cron.
- **Duplicate detection across data sources.** The existing cleanup
  function already removes cross-source duplicates by `(job_title,
  duty_station, end_date)` keeping the earliest posted. ReliefWeb rows will
  participate naturally; no special handling needed.
- **API token rate-limit / quota response.** Treat as a 4xx; abort the run,
  log failure, no retry until next day.

## Empty / Loading / Error States

- **Empty result set.** Run completes with `processedCount = 0,
  successCount = 0, errorCount = 0` and a `success` ETL status row. Logs
  note "No ReliefWeb jobs returned".
- **Partial success.** Reported via `successCount` and `errorCount`. Status
  is `success` if `errorCount < processedCount`, `failed` only if the run
  could not complete (network abort, missing env, DB connection failure).
- **Total failure (no rows touched).** Status `failed`, error message
  populated, no Redis flush, no cleanup pass.
- **Dashboard view.** New `RELIEFWEB` row appears in the ETL dashboard once
  the first run logs status; before that, the dashboard simply does not
  list it (dashboard reads `latest_etl_status` view).

## Permissions / Access Behavior

- ReliefWeb API is public; the `appname` is an identifier, not a secret.
  Treat it as configuration, not credential. Still keep it in `.env` so it
  isn't checked into source.
- No new auth on the API surface. The existing `auth` and `optionalAuth`
  middlewares stay untouched.
- The ETL controller routes already gated behind the static-token `auth`
  middleware do not change. No new endpoints are introduced.

## Acceptance Criteria

1. **Module exists.** `src/etl/etl-reliefweb.js` exports
   `fetchAndProcessReliefwebJobVacancies` returning the documented shape.
2. **Standalone runner exists.** `run-reliefweb-etl.js` runs the ETL via
   `node run-reliefweb-etl.js`, prints a summary, and exits with code 0 on
   success.
3. **Schedule registered.** `src/app.js` registers exactly one new
   `cron.schedule('0 5 * * *', ...)` for ReliefWeb. No other cron entries
   are added or removed.
4. **No schema changes.** `src/etl/database-schema.sql` is unchanged. No
   migrations are added. The `organization` data insert (ReliefWeb row) is
   idempotent and does not alter constraints.
5. **No regression.** All twelve existing agency ETLs still appear in the
   `etlJobs` array in the same order, all existing crons still fire, and
   social-media posting still works.
6. **Daily run produces ≤ 1,000 upserts.** A live run inserts new rows with
   `data_source = 'reliefweb'`, count ≤ 1,000, no duplicates, and the
   dashboard shows a `success` `RELIEFWEB` row.
7. **Re-run is idempotent.** A second consecutive run on the same data
   produces zero net new rows (only updates), and `errorCount = 0`.
8. **Missing env handled.** With `RELIEFWEB_APPNAME` unset, the ETL returns
   failure within milliseconds, logs `failed`, and does not call the API.
9. **Lock-contention handled.** If invoked while another agency is
   running, the run is skipped without partial work and logged as failed
   with the lock-denied reason.
10. **Frontend integration is automatic.** Hitting existing `/api/v1/jobs`
    endpoints after a ReliefWeb run returns ReliefWeb postings alongside
    existing sources without any frontend deploy.

## Assumptions

- ReliefWeb's `appname` provided by the user
  (`unjobzoneGT-6538GBst5zxcGrst5m`) is valid for unauthenticated access at
  the documented daily quota and continues to be valid.
- The 1,000-row daily ceiling, in combination with `preset=latest`, gives
  acceptable freshness for our use case. We are not chasing every posting,
  just a daily snapshot of the most recent 1,000.
- ReliefWeb response shape under `profile=full` matches the documented
  fields (`title`, `body`, `body-html`, `date.created`, `date.closing`,
  `country`, `city`, `type`, `theme`, `career_categories`, `experience`,
  `source`, `url`, `url_alias`). If a field is missing for a given record,
  the mapping degrades to empty string / NULL per F3.
- The existing `unique_job_vacancy` constraint on `(job_id, data_source,
  organization_id)` is sufficient to dedupe ReliefWeb upserts. Cross-source
  collisions on the same `job_id` value are extremely unlikely because
  ReliefWeb IDs are numeric and our other sources use string IDs from
  Workday/Inspira/etc.
- 5:00 AM server time is acceptably free of contention with the 6:00 AM
  scheduled run; one full ReliefWeb pass (≤ five paginated API calls plus
  ≤ 1,000 upserts) completes well under an hour.
- Adding a `'ReliefWeb'` row to the `organization` table is safe and not
  in conflict with any existing row.
- We accept that ReliefWeb postings without a `date.closing` will not be
  auto-expired by `cleanupExpiredAndDuplicateJobs`. This matches today's
  behavior for any other source that lacks an end date.

## Open Questions

1. **Daily slot.** Is 5:00 AM server time the right slot, or should
   ReliefWeb piggy-back on the 6 AM `runEtl()` (added to the `etlJobs`
   array)? Standalone is recommended for isolation; flag for confirmation. OK. STANDALONE
2. **Redis flush.** Should a successful ReliefWeb run also re-trigger
   social-media posting flows? Default: no — only ETL ingestion changes,
   social-media schedules continue independently. No
3. **Job-network categories.** Do we want to map ReliefWeb's
   `career_categories` to UN job-network names (so ReliefWeb postings
   participate in the hourly social-media posts) or leave them as-is? The
   spec assumes leave-as-is; revisit if/when we expand social posting. If possible, YES.
4. **ReliefWeb rate-limit headers.** Does the public endpoint expose
   `X-RateLimit-*` headers we should respect? If so, treat 429 as an
   abort-and-retry-tomorrow rather than retrying within the same run.
   Default behavior (abort on 4xx) is acceptable until evidence otherwise. Okay.
5. **Org-table insert.** Confirm whether `organization` has a unique
   constraint on `name` / `code`. If not, the spec's idempotent insert
   becomes a one-time manual seed; no schema change either way. OK
