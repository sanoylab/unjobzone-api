# Implementation Plan — ReliefWeb ETL Data Source

Based on: `_specs/reliefweb-etl-data-source.md`

## 1. Overview

Add a new daily ETL pipeline that pulls humanitarian-sector job postings
from the public ReliefWeb v2 jobs API, transforms them into the existing
`job_vacancies` schema, and upserts up to 1,000 rows per run into the
production Postgres instance. The feature is purely additive — every
existing scraper, schedule, controller, social-media flow, and frontend
behavior must continue to work unchanged.

**Success looks like**:

- A new module `src/etl/etl-reliefweb.js` with a single ETL entry point.
- A new daily standalone cron (`0 5 * * *`) in `src/app.js`.
- A new env var `RELIEFWEB_APPNAME` consumed by the module.
- A new `RELIEFWEB` row appearing in the existing ETL status dashboard
  after the first run.
- ReliefWeb postings appear in `/api/v1/jobs*` results identified by
  `data_source = 'reliefweb'`.
- ReliefWeb postings participate in the hourly social-media posting
  schedule when their `jn` value is mapped to one of the existing UN
  job-network names (per resolved Open Question #3).
- All twelve existing agency ETLs and all existing crons remain
  unchanged and untouched.

## 2. Assumptions

Carrying forward from the spec, plus the user's answers to open questions:

- **Standalone cron** (Open Q1 → confirmed): ReliefWeb runs as its own
  daily `cron.schedule('0 5 * * *', ...)`, NOT inside the `etlJobs`
  array of `runEtl()`.
- **No social-media re-trigger** (Open Q2 → confirmed): ReliefWeb's
  successful run does not invoke any LinkedIn / Facebook posting paths
  itself. The existing hourly crons remain the only triggers.
- **Job-network mapping** (Open Q3 → confirmed YES if possible): the
  module performs a best-effort mapping from ReliefWeb's
  `career_categories` to UN job-network names so that the existing
  hourly social-media crons (which filter on `jn`) automatically pick up
  ReliefWeb rows. Unmappable categories store the original ReliefWeb
  string, ensuring no row is dropped, but those rows simply won't be
  posted.
- **Rate-limit handling** (Open Q4 → accepted default): treat 429 / 4xx
  responses as abort-this-run-and-retry-tomorrow. No special
  `X-RateLimit-*` parsing in v1.
- **Org-table insert** (Open Q5 → accepted): a single seed row in
  `organization` for ReliefWeb. We do not introduce a unique constraint
  if none exists; we use a defensive `WHERE NOT EXISTS` style insert.
- ReliefWeb v2 API is publicly available without auth and the
  `appname=unjobzoneGT-6538GBst5zxcGrst5m` value remains valid.
- ReliefWeb's `profile=full` returns the documented `fields` shape
  (`title`, `body`, `body-html`, `date.created`, `date.closing`,
  `country[]`, `city[]`, `type[]`, `theme[]`, `career_categories[]`,
  `experience[]`, `source[]`, `url`, `url_alias`).
- The existing unique constraint
  `unique_job_vacancy (job_id, data_source, organization_id)` is enough
  to dedupe ReliefWeb upserts.
- `cleanupExpiredAndDuplicateJobs` will pick up ReliefWeb rows naturally
  via its `(job_title, duty_station, end_date)` cross-source heuristic.
- 5:00 AM server-time slot is conflict-free with the existing 6:00 AM
  full ETL run (the locks would prevent overlap regardless).
- A full ReliefWeb pass (≤ 5 paginated calls + ≤ 1,000 upserts)
  completes well under the 2-hour stale-running threshold and well
  under the 6:00 AM cron.

## 3. Architecture Impact

### Frontend (`unjobzone-frontend-cursor/`)

- **No changes.** ReliefWeb postings surface through existing list/
  filter endpoints because the frontend is `data_source`-agnostic.

### Backend (`unjobzone-etl-api-cursor/`)

- **New file** `src/etl/etl-reliefweb.js` — ETL module.
- **New file** `run-reliefweb-etl.js` (repo root) — standalone runner.
- **Modified** `src/app.js` — one new `cron.schedule(...)` block plus
  one `require(...)` for the new module. No edits to `etlJobs`, no
  edits to existing crons, no edits to social-media helpers.
- **Optional modify** `package.json` — add a script
  `"run-reliefweb-etl": "node run-reliefweb-etl.js"` for parity with
  the existing `npm run job-monitor` style scripts.
- **Doc edits** `README.md` and `CLAUDE.md` — add `RELIEFWEB_APPNAME`
  to the env section and a one-line note about the new agency.
- **No changes** to controllers, routers, middleware, Sentry wiring,
  Swagger docs, social-media helpers, or any other ETL module.

### Database

- **No schema changes.** No migrations, no new tables, no new columns,
  no new indexes, no new constraints.
- **One data seed**: an `INSERT ... WHERE NOT EXISTS` for a ReliefWeb
  row in the `organization` table, executed at module load (idempotent,
  safe across multiple runs and multiple instances).
- All writes flow through existing `upsertJobVacancy` and use the
  existing `unique_job_vacancy` constraint.

### Routing / Navigation

- None.

### Auth / Roles

- None. ReliefWeb API is unauthenticated; `appname` is an identifier,
  not a credential. No new endpoints, no new middleware.

### External Integrations

- New outbound integration: ReliefWeb v2 jobs API
  (`https://api.reliefweb.int/v2/jobs`).
- No new inbound dependencies.

## 4. Detailed Execution Phases

### Phase 1 — Configuration scaffolding

**Objective**: get the env var plumbed and documented before writing
ETL logic.

**Tasks**:

1. Add `RELIEFWEB_APPNAME=unjobzoneGT-6538GBst5zxcGrst5m` to local
   `.env` (NOT committed) and to `.env.example` if one exists.
2. Add `RELIEFWEB_APPNAME` to the env-variables section of
   `README.md`.
3. Append to `CLAUDE.md` "Environment variables → Backend" list:
   `RELIEFWEB_APPNAME` — ReliefWeb appname identifier (not a secret;
   public API).
4. Append to `CLAUDE.md` "Backend architecture → ETL pipeline" the
   note that ReliefWeb is a 13th source running on its own daily
   cron at 05:00 server time, NOT inside `runEtl()`.
5. Confirm production env (Render) has `RELIEFWEB_APPNAME` set —
   document the action item; do not modify Render config in code.

**Outputs**: `.env` updated locally, `README.md` and `CLAUDE.md`
updated.

**Dependencies**: none.

**Edge cases**: none.

### Phase 2 — Job-network mapping table

**Objective**: define the ReliefWeb-`career_categories` →
UN-`jn` mapping that lets ReliefWeb rows participate in the hourly
social-media crons in `src/app.js`.

**Tasks**:

1. Inside `src/etl/etl-reliefweb.js`, declare a constant
   `RELIEFWEB_CAREER_TO_JN` keyed on ReliefWeb category names
   (case-insensitive at lookup time). Initial mapping:

   | ReliefWeb `career_categories[].name`     | Mapped `jn` value (matches `app.js` exactly)        |
   | ---------------------------------------- | --------------------------------------------------- |
   | "Information Technology"                 | "Information and Telecommunication Technology"     |
   | "Information Management"                 | "Information and Telecommunication Technology"     |
   | "Advocacy/Communications"                | "Communication"                                    |
   | "Media/Public Information"               | "Public Information and Conference Management"     |
   | "Donor Relations/Grants Management"      | "Management and Administration"                    |
   | "Administration/Finance"                 | "Management and Administration"                    |
   | "Human Resources"                        | "Management and Administration"                    |
   | "Logistics/Procurement"                  | "Logistics, Transportation and Supply Chain"       |
   | "Supply Chain"                           | "Logistics, Transportation and Supply Chain"       |
   | "Program/Project Management"             | "Health, Project Management, Programme Management" |
   | "Monitoring and Evaluation"              | "Health, Project Management, Programme Management" |
   | "Health Services"                        | "Health, Project Management, Programme Management" |
   | "Public Health"                          | "Health, Project Management, Programme Management" |
   | "Medical/Public Health"                  | "Health, Project Management, Programme Management" |
   | "Humanitarian/Emergency Affairs"         | "Political, Peace and Humanitarian"                |
   | "Peace and Conflict"                     | "Political, Peace and Humanitarian"                |
   | "Protection and Human Rights"            | "Political, Peace and Humanitarian"                |
   | "Legal Affairs"                          | "Legal"                                            |
   | "Safety and Security"                    | "Internal Security and Safety"                     |
   | "Research"                               | "Science"                                          |
   | "Information and Communications Technology (ICT)" | "Information and Telecommunication Technology" |
   | "Economic Recovery and Development"      | "Economic, Social and Development"                 |
   | "Food Security"                          | "Economic, Social and Development"                 |
   | "Livelihoods"                            | "Economic, Social and Development"                 |

2. Provide a `mapToJn(reliefwebCategory)` helper that returns the
   mapped value, or the original string if no mapping exists.
3. Note in a one-line code comment WHY this mapping exists: it lets
   ReliefWeb rows participate in the hourly social-media crons that
   filter on `jn`. (Per CLAUDE.md, default to no comments — but this
   is a "non-obvious why" exception.)

**Outputs**: a constant + helper local to the new module.

**Dependencies**: confirmation of the exact `jn` strings used in
`app.js` social-media crons (already inventoried in this plan).

**Edge cases**:

- ReliefWeb returns multiple `career_categories`. Use the FIRST
  category for `jn` mapping; store the same first-category name in
  `category_code`. (Mirrors the spec's F3 mapping.)
- Empty `career_categories` array → `jn = ''`, `category_code = ''`.
- Unknown category → store original string; row will not match any
  hourly cron and will be silently excluded from social posts. This
  is acceptable — better than losing the data.

### Phase 3 — ReliefWeb fetch + transform module

**Objective**: implement `src/etl/etl-reliefweb.js`.

**Tasks**:

1. Module header: `require("dotenv").config()`, import `pg.Client`,
   import `credentials` from `./db`, import the helpers
   `getOrganizationId`, `upsertJobVacancy`, `validateJobData`,
   `safeApiCall` from `./shared`.
2. Constants:
   - `BASE_URL = 'https://api.reliefweb.int/v2/jobs'`
   - `MAX_JOBS = 1000`
   - `PAGE_SIZE = 200`
   - `DATA_SOURCE = 'reliefweb'`
   - The `RELIEFWEB_CAREER_TO_JN` map from Phase 2.
3. Implement `seedReliefwebOrganization(client)`:
   - `INSERT INTO organization (name, code, short_name, long_name)
     SELECT 'ReliefWeb','RELIEFWEB','ReliefWeb','ReliefWeb'
     WHERE NOT EXISTS (SELECT 1 FROM organization WHERE name ILIKE 'ReliefWeb' OR code ILIKE 'RELIEFWEB')`.
   - Idempotent and safe across instances.
   - Wrap in try/catch and log a warning on failure (do not fail the
     ETL — fallback to id 128 still works).
4. Implement `transformJob(item)`:
   - Validate required source fields (`item.id`, `item.fields.title`).
     If missing, return `null`.
   - Build the `jobData` object per the spec's F3 table.
   - Concatenate `duty_station` from `fields.city[*].name` +
     `fields.country[*].name`, joined with `, `, deduped.
   - Coalesce `body-html` → `body` for `job_description`. Strip null
     bytes (` `) and ASCII control chars 0x01–0x08, 0x0E–0x1F.
   - Parse dates: `new Date(...)`; reject NaN.
   - Pick `dept` from `fields.source[0].name` else `'ReliefWeb'`.
   - Pick `jn` via `mapToJn(fields.career_categories[0]?.name)`.
   - Pick `jf` from `fields.theme[0]?.name`.
   - Pick `jl` from `fields.experience[0]?.name`.
   - Pick `apply_link` from `fields.url_alias` else `fields.url`.
   - Stringify `job_id` (ReliefWeb returns numeric IDs but our
     `job_id` column is text-friendly).
5. Implement `fetchPage(offset)`:
   - Build URL with all query params.
   - Call `safeApiCall(url, {}, 3, 30000)`.
   - Return the parsed `data` array on success or throw on permanent
     failure.
6. Implement `fetchAndProcessReliefwebJobVacancies()`:
   - Read `process.env.RELIEFWEB_APPNAME`. If missing/empty, return
     `{ success: false, error: 'RELIEFWEB_APPNAME not set',
       processedCount: 0, successCount: 0, errorCount: 0 }`.
   - Banner-log start.
   - Open `pg.Client`, connect.
   - Call `seedReliefwebOrganization(client)`.
   - Loop: offset = 0; while offset < MAX_JOBS:
     - `safeApiCall` for `limit=PAGE_SIZE&offset=<offset>`.
     - On hard failure, set the run result to failure and break.
     - For each item, call `transformJob`. Skip nulls (counted as
       `errorCount` only for items with required fields missing —
       silently skip when source is empty).
     - Resolve `organization_id` via `getOrganizationId(jobData.dept)`.
     - Call `upsertJobVacancy(client, jobData, 'RELIEFWEB')`.
     - Increment counters: `processedCount`, `successCount`,
       `errorCount`.
     - If page returned `< PAGE_SIZE` items, break.
     - `offset += PAGE_SIZE`.
   - Return `{ success: true, processedCount, successCount,
     errorCount }` on completion. Return `{ success: false, error,
     processedCount, successCount, errorCount }` on hard failure.
   - In `finally`: `client.end()`.

**Outputs**: a working `src/etl/etl-reliefweb.js` exporting
`fetchAndProcessReliefwebJobVacancies` matching the contract
expected by `app.js`.

**Dependencies**: Phases 1 and 2.

**Edge cases**:

- 4xx (including 429) from ReliefWeb → treated as hard failure;
  abort the run, log failed status, partial upserts persist.
- 5xx / network timeout → `safeApiCall` retries 3× with exponential
  backoff; on final failure, treat as 4xx behavior.
- Empty `data` array on first page → `success` with all counters 0.
- Item missing `id` → skip silently (don't bump errorCount; not our
  data quality issue).
- Item missing `title` → bump `errorCount`, skip.
- Item with malformed dates → bump `errorCount`, skip.
- Same job appears twice in the same paginated set → unique
  constraint dedupes via upsert; second occurrence is a no-op
  update.
- ReliefWeb listing in non-English → still stored as `language='EN'`
  per spec; we do not attempt language detection.

### Phase 4 — Cron registration in `src/app.js`

**Objective**: wire the module into a daily standalone schedule.

**Tasks**:

1. Add one `require` near the existing ETL imports:
   `const { fetchAndProcessReliefwebJobVacancies } =
   require("./etl/etl-reliefweb");`
2. Below the existing 6 PM ETL cron and before the social-media
   crons, insert one new block:
   - `cron.schedule('0 5 * * *', async () => { ... })`
   - Inside: emit a banner log; acquire the `RELIEFWEB` ETL lock; if
     denied, log skip and write a `failed` `etl_status` row noting
     the lock-denied reason; if acquired, write `running` status,
     call `fetchAndProcessReliefwebJobVacancies()`, write `success`
     or `failed` status with counts, release the lock, flush
     `jobs:*` Redis keys on success, then call
     `cleanupExpiredAndDuplicateJobs()` on success.
   - This block mirrors the per-agency block already inside
     `runEtl()` but is standalone.
3. Do NOT add ReliefWeb to the `etlJobs` array.
4. Do NOT change the startup `runEtl()` call.
5. Do NOT touch any social-media or blog crons.

**Outputs**: a single new cron registration in `app.js`.

**Dependencies**: Phase 3.

**Edge cases**:

- Server restart between 5:00 AM and 6:00 AM: the 6 AM `runEtl()`
  cron still fires; ReliefWeb's lock has already been released by
  then, so no contention.
- Server timezone differences: cron runs in server local time,
  matching all other cron entries — same behavior as today.
- A long-running ReliefWeb run (very unlikely with ≤ 1,000 upserts)
  could overlap 6 AM. Locks prevent corruption; the 6 AM agencies
  that need the lock will skip and retry that evening.

### Phase 5 — Standalone runner

**Objective**: ad hoc dev script.

**Tasks**:

1. Create `run-reliefweb-etl.js` at repo root, mirroring the
   structure of `run-unicef-etl.js` and `run-unops-etl.js`:
   - `require('dotenv').config()`.
   - Wrap `acquireETLLock('RELIEFWEB')` and `releaseETLLock` around
     the call so an ad hoc run doesn't race the production cron.
   - Log status transitions via `logETLStatus` so dashboard
     reflects the dev run.
   - Call `fetchAndProcessReliefwebJobVacancies()`.
   - Print a one-screen summary.
   - Exit with `process.exit(0)` on success, `process.exit(1)` on
     failure.
2. Add npm script `"run-reliefweb-etl": "node run-reliefweb-etl.js"`
   to `package.json`.

**Outputs**: `run-reliefweb-etl.js` and updated `package.json`.

**Dependencies**: Phase 3.

**Edge cases**:

- Run while production cron is mid-flight: lock denied, exit code 1
  with explicit message. Acceptable for a dev script.

### Phase 6 — Verification & documentation

**Objective**: confirm no regressions and document the new feature.

**Tasks**:

1. Smoke run: `npm run run-reliefweb-etl` against staging or a
   local DB. Verify:
   - Up to 1,000 rows with `data_source='reliefweb'` exist.
   - `etl_status` has a `RELIEFWEB` row with `status='success'`.
   - At least one ReliefWeb row maps to a known `jn` value.
   - Re-running produces 0 net new rows.
2. Spot-check via API: `GET /api/v1/jobs?data_source=reliefweb` (or
   the equivalent existing filter) returns ReliefWeb rows.
3. Verify no other agency ETL was disturbed: run
   `node force-cleanup-etl-locks.js`-style ad hoc check, or
   `npm run dev` and confirm `runEtl()` startup logs all 12 existing
   agencies as before.
4. Update `README.md` with a one-line addition under the agency list
   noting the 13th source.
5. Update `CLAUDE.md` `Backend architecture → Scheduled jobs` section
   to mention `0 5 * * *` ReliefWeb daily.
6. Open a brief PR description noting: net-new module, one new env
   var, one new cron, one data-only org seed, no schema changes.

**Outputs**: green smoke run, doc updates, PR.

**Dependencies**: Phases 1–5.

**Edge cases**: production env missing `RELIEFWEB_APPNAME` → first
cron run will gracefully fail with a `failed` `etl_status` row;
add the var on Render before merging if not already set.

## 5. Functional Coverage

| Spec section / flow                              | Phase | Concrete task |
| ------------------------------------------------ | ----- | ------------- |
| Flow 1 — scheduled daily ingestion               | 4     | `cron.schedule('0 5 * * *', ...)` block |
| Flow 2 — ad hoc developer run                    | 5     | `run-reliefweb-etl.js` + npm script |
| Flow 3 — end-user search                         | n/a   | Automatic via existing `/api/v1/jobs*` |
| F1 — module shape                                | 3     | `etl-reliefweb.js` exports & return contract |
| F2 — fetch behavior                              | 3     | `fetchPage` + pagination loop |
| F3 — field transformation                        | 3     | `transformJob` |
| F4 — organization resolution                     | 3     | `seedReliefwebOrganization` + `getOrganizationId` |
| F5 — persistence                                 | 3     | `upsertJobVacancy` integration |
| F6 — schedule and orchestration                  | 4     | Standalone cron, NOT in `etlJobs` |
| F7 — configuration                               | 1, 3  | `.env`, README/CLAUDE updates, env-check |
| F8 — observability                               | 3, 4  | `logETLStatus` + banner logs |
| F9 — standalone runner                           | 5     | `run-reliefweb-etl.js` |
| Open Q3 — career-category → `jn` mapping         | 2     | `RELIEFWEB_CAREER_TO_JN` table |

## 6. Data and State Considerations

### Entities involved

- **`job_vacancies`** — target table. No schema change; we only
  insert/update via the existing `upsertJobVacancy` helper using
  `data_source='reliefweb'`.
- **`organization`** — read-mostly. We add one seed row
  ("ReliefWeb") so per-job source resolution has a deterministic
  fallback.
- **`etl_status`** — write-only from this module via
  `logETLStatus('RELIEFWEB', ...)`.
- **Redis (`jobs:*` keys)** — flushed on success.

### Validation rules

Already enforced by the existing `validateJobData` and
`upsertJobVacancy` helpers. Module-level extras:

- `RELIEFWEB_APPNAME` non-empty.
- `data[].id` truthy.
- `fields.title` truthy and ≤ 500 chars (validator rejects over-length).
- `fields.date.created` / `fields.date.closing` parse as valid dates
  when present.

### State transitions

Per ReliefWeb run:

1. `running` (lock acquired) →
2. either `success` (counts logged) or `failed` (error logged),
   followed by lock release.

Lock contention path:

1. Lock denied → `failed` row with reason. No further state changes.

### Loading / empty / error handling

- **Empty result**: success status with 0/0/0 counters.
- **Partial success**: success status with `errorCount > 0` so long
  as the run completed.
- **Hard failure mid-run**: failed status with the error message;
  partial upserts persist because each upsert auto-commits.
- **Missing env**: failed status, no API call.
- **DB connection failure**: caught, failed status if possible,
  client.end in `finally`.

### Concurrency / consistency

- ETL lock at the `etl_status` level prevents this run from
  overlapping any other agency run.
- Within a single run, all upserts use one `pg.Client`; no
  connection pooling concerns.
- The CLAUDE.md gotcha about scaling out backend instances still
  applies — the lock is logical, not advisory. We are not changing
  this assumption.
- The `organization` seed is `WHERE NOT EXISTS`; safe under
  concurrent module loads.

## 7. UI/UX Considerations

- **No frontend changes.** ReliefWeb postings appear automatically.
- The ETL dashboard (existing `/api/v1/etl/...` routes) gains a new
  `RELIEFWEB` row after the first run. No layout adjustments needed
  because the dashboard is data-driven.
- Accessibility / responsive concerns: none, no new UI surface.

## 8. Backend / API Considerations

### Endpoints

- **No new endpoints.** No changes to controllers, routers, or
  middleware.
- Existing job-listing endpoints remain `data_source`-agnostic; they
  already handle arbitrary `data_source` values.

### Request / response expectations

- Outbound only: `GET https://api.reliefweb.int/v2/jobs?...` with
  `Accept: application/json`. No body. No auth headers.
- Expected response: `{ data: [{ id, fields: {...} }, ...], totalCount,
  ... }`. Read defensively — only the fields named in F3 are required.

### Authorization

- None added.

### Failure handling

- 4xx (including 429): abort, log failed.
- 5xx / network: retry via `safeApiCall` (3× exp backoff), then
  abort.
- DB error mid-upsert: caught per-row inside `upsertJobVacancy`;
  errorCount bumped; loop continues.
- Lock acquisition failure: abort cleanly, log failed.

## 9. Testing Plan

The repo has no unit-test runner (`npm test` is a stub) and no
integration test harness. Verification is manual / ad hoc, matching
the existing operational style (`test-*.js` scripts at repo root).

### Manual verification

1. **Happy path**: `npm run run-reliefweb-etl` → expect ≤ 1,000 rows
   with `data_source='reliefweb'`, `etl_status` shows `success`.
2. **Idempotency**: rerun immediately → 0 net new rows, `errorCount=0`.
3. **Missing env**: temporarily unset `RELIEFWEB_APPNAME`, rerun →
   immediate failure response, `etl_status` shows `failed` with the
   correct error message, no API call attempted (verifiable via
   absence of network log lines).
4. **Lock contention**: in one shell start the standalone ETL; in a
   second shell start it again immediately → second run denies with
   lock-already-held message and exits 1.
5. **Field-mapping spot check**: pick 5 random rows from a
   successful run; manually compare against the corresponding
   ReliefWeb posting URL → `job_title`, `apply_link`, `duty_station`,
   `dept`, `jn` all sensible.
6. **Job-network mapping**: query
   `SELECT jn, COUNT(*) FROM job_vacancies WHERE data_source='reliefweb' GROUP BY jn`.
   Confirm at least 3 of the canonical `jn` values from `app.js`
   appear (e.g. "Information and Telecommunication Technology",
   "Communication", "Management and Administration").
7. **No regression on existing ETLs**: `npm run dev`, observe
   startup logs — all 12 agencies still attempt their runs. Pick
   one (e.g. UNDP) and confirm a few rows updated.
8. **Production cron dry-run**: temporarily change the cron string
   to `* * * * *` in a non-production env; observe one cycle
   completes; revert before merging.

### Edge case verification

- Inject a broken record (manually) into a local mock response →
  confirm `errorCount` bumps and run continues.
- Test pagination break: configure `MAX_JOBS=10` → confirm exactly
  10 (or fewer) rows ingested.
- Test 429 simulation: point `BASE_URL` at a local 429-returning
  server → confirm hard failure with proper status logging.

### Regression checks

- `npm run lint` (if applicable to backend; if not, N/A).
- Visual diff of `app.js` to confirm ONLY the new cron block and
  the one new `require` were added.
- Production smoke after deploy: visit
  `/api/v1/etl/...` dashboard endpoints; confirm `RELIEFWEB` row
  appears the morning after the first scheduled run.

## 10. Risks and Traps

| Risk                                                           | Mitigation |
| -------------------------------------------------------------- | ---------- |
| ReliefWeb API shape drift (renamed fields)                     | Defensive `?.` access; null-safe in `transformJob`; log unparseable items but continue. |
| Hardcoded `appname` leaks into VCS                             | Read from env only; never log it; document as not-a-secret in CLAUDE.md. |
| New cron collides with 6 AM ETL                                | 5 AM slot + ETL lock. Locks already prevent overlap by design. |
| Long-running ReliefWeb pagination starves the 6 AM run         | 1,000-row cap + 5 paginated calls = single-digit minutes; well under 1 h. |
| `getOrganizationId` returns 128 too often (every row → UN)     | Seed the ReliefWeb org row; verify after first run that distinct `organization_id` values exist. If 100% land on 128, log and revisit. |
| Cross-source duplicate cleanup deletes legitimate ReliefWeb rows | Existing `(job_title, duty_station, end_date)` cleanup keeps earliest-posted; ReliefWeb rows from a fresh source will frequently be the first occurrence and survive. Acceptable. |
| `jn` mapping silently mis-classifies and floods one social-media slot | Mapping is best-effort; verify post-first-run distribution. If skew, narrow the table. |
| Production env missing `RELIEFWEB_APPNAME`                     | First cron run logs a clean failure; add var on Render before merging. |
| Render's puppeteer/Chrome layer disturbed                      | This feature uses no browser; no Render config change required. |
| Frontend hardcodes API URL — not a risk for this feature       | n/a |

## 11. Definition of Done

- [ ] `src/etl/etl-reliefweb.js` exists and exports
      `fetchAndProcessReliefwebJobVacancies`.
- [ ] `run-reliefweb-etl.js` exists at repo root and runs
      end-to-end.
- [ ] `package.json` has a `run-reliefweb-etl` script.
- [ ] `src/app.js` has exactly one new `cron.schedule('0 5 * * *', ...)`
      block + one new `require`. No other diffs in `app.js`.
- [ ] `RELIEFWEB_APPNAME` is documented in `README.md` and
      `CLAUDE.md`.
- [ ] No schema changes. No migrations. `database-schema.sql`
      unchanged.
- [ ] One ReliefWeb row in `organization` table (seeded
      idempotently).
- [ ] First scheduled run produces ≤ 1,000 rows with
      `data_source='reliefweb'`.
- [ ] `etl_status` shows a `RELIEFWEB` row with `status='success'`.
- [ ] Re-run is idempotent (0 net new rows, `errorCount=0`).
- [ ] All twelve existing agency ETLs still run on the existing
      6 AM / 6 PM crons without changes.
- [ ] All thirteen social-media crons (07–16, 19–20) unchanged.
- [ ] At least one ReliefWeb row's `jn` matches a canonical UN
      job-network name.
- [ ] Frontend integration verified: ReliefWeb rows visible via
      `/api/v1/jobs*` without any frontend deploy.
- [ ] No lint errors introduced (where applicable).

## 12. Suggested Implementation Order

1. **Phase 1 — Configuration**: add `RELIEFWEB_APPNAME` to `.env`,
   `README.md`, `CLAUDE.md`. (~10 min)
2. **Phase 2 — Mapping table**: define the constant and helper
   inside the new module file (start the file). (~15 min)
3. **Phase 3 — ETL module**: implement `transformJob`,
   `fetchPage`, `seedReliefwebOrganization`, and the orchestrator
   `fetchAndProcessReliefwebJobVacancies`. (~60–90 min)
4. **Phase 5 — Standalone runner**: write
   `run-reliefweb-etl.js`, add npm script. Smoke-test against a dev
   DB. Confirm ≤ 1,000 rows land. (~20 min)
5. **Phase 4 — Cron registration**: add the single
   `cron.schedule('0 5 * * *', ...)` block in `app.js`, with the
   per-agency lock/log/cleanup pattern. (~20 min)
6. **Phase 6 — Verification & docs**: run all manual checks from §9,
   update docs, open PR. (~30 min)

Total estimate: ~3–4 hours single-pass implementation.
