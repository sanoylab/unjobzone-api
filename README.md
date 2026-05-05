# UN Job Zone — ETL & API

The backend that powers [UN Job Zone](https://www.unjobzone.com): a Node.js / Express service that scrapes job vacancies from **13 United Nations agencies and humanitarian organizations**, normalizes them into a single Postgres schema, exposes them via a REST API, and automatically posts opportunities to LinkedIn and Facebook on a schedule.

> Open-source companion to [`unjobzone-frontend`](../unjobzone-frontend-cursor) — together they form a full job aggregation platform for UN-system careers.

---

## What it does

- **Aggregates UN job listings** from 13 sources into one consistent dataset
- **Exposes a public REST API** with searchable, filterable job listings, organization metadata, ETL status, and a blog backend
- **Runs automatic social-media posting** to LinkedIn and Facebook (hourly, by job network category, plus a daily expiring-soon digest)
- **Self-heals**: per-organization ETL locks, stale-run cleanup, automatic deduplication, expired-job purging, and Redis cache invalidation
- **Ships with observability**: Sentry error / performance tracking and a Swagger UI at `/api/v1`

## Data sources

| # | Source | Type |
|---|--------|------|
| 1 | **IMF** — International Monetary Fund | HTML scrape |
| 2 | **UNHCR** — UN Refugee Agency | HTML scrape |
| 3 | **WFP** — World Food Programme | HTML scrape |
| 4 | **INSPIRA** — UN Secretariat (careers.un.org) | Headless browser (Puppeteer) |
| 5 | **UNDP** — UN Development Programme | HTML scrape |
| 6 | **UN Women** | HTML scrape |
| 7 | **ICAO** — Intl. Civil Aviation Organization | Headless browser (Puppeteer) |
| 8 | **UNFPA** — UN Population Fund | HTML scrape |
| 9 | **IOM** — Intl. Organization for Migration | HTML scrape |
| 10 | **UNICEF** | HTML scrape |
| 11 | **UNOPS** — UN Office for Project Services | HTML scrape |
| 12 | **UNESCO** | Headless browser (Puppeteer) |
| 13 | **ReliefWeb** (humanitarian sector) | Public REST API |

Each source has its own module under `src/etl/etl-<agency>.js` exporting a `fetchAndProcess<Agency>JobVacancies()` function.

## Architecture

```
┌────────────────┐   cron    ┌─────────────────┐    upsert    ┌────────────┐
│  UN websites   │ ────────▶ │   ETL workers   │ ───────────▶ │  Postgres  │
│ + ReliefWeb v2 │           │ (axios | puppet)│              │            │
└────────────────┘           └────────┬────────┘              └─────┬──────┘
                                      │ flush                       │
                                      ▼                             │
                                ┌──────────┐         ┌──────────────▼──────┐
                                │  Redis   │ ◀────── │   Express REST API  │
                                │  cache   │         │   (/api/v1/*)       │
                                └──────────┘         └──────────┬──────────┘
                                                                │
                                       ┌────────────────────────┼─────────────┐
                                       ▼                        ▼             ▼
                                  LinkedIn API            Facebook API   Frontend SPA
```

### Key design choices

- **Per-organization ETL locks** in Postgres prevent overlapping runs of the same scraper.
- **Status table (`etl_status`)** logs every transition (`running` → `success`/`failed`) for the dashboard.
- **Stale-run cleanup** wipes orphaned `running` rows at the start of every full ETL — so a crashed run doesn't permanently lock an agency.
- **Cleanup pipeline** removes expired jobs and same-org / cross-org duplicates after every successful agency.
- **Puppeteer with axios fallback** — JS-rendered scrapers degrade gracefully to static HTML when Chrome isn't available.
- **ReliefWeb is isolated** on its own daily cron (separate from `runEtl()`) and capped at 1,000 rows per run.

## Tech stack

- **Runtime**: Node.js, Express 4
- **Database**: Postgres (via `pg`)
- **Cache**: Redis
- **Scraping**: `axios` + `cheerio` for static, `puppeteer` for JS-rendered
- **Scheduling**: `node-cron`
- **Docs**: `swagger-jsdoc` + `swagger-ui-express`
- **Observability**: `@sentry/node`
- **Email** (ICAO monitor): `nodemailer`

## Quick start

### Prerequisites

- Node.js 18+
- PostgreSQL 13+
- Redis 6+
- (Optional) Chrome / Chromium for Puppeteer-based scrapers

### Install

```bash
git clone <your-fork-url>
cd unjobzone-etl-api-cursor
npm install
```

### Configure

Create a `.env` file in the project root:

```bash
# Application
NODE_ENV=development
PORT=3000

# Postgres
PGUSER=postgres
PGHOST=localhost
PGDATABASE=unjobzone
PGPASSWORD=postgres
PGPORT=5432

# Redis
REDIS_URL=redis://localhost:6379

# API auth (static bearer tokens)
ACCESS_TOKEN_SECRET=replace-me
TEMPO_ACCESS_TOKEN_SECRET=replace-me

# Sentry (optional)
SENTRY_DEBUG=false

# ReliefWeb — required for the ReliefWeb ETL to run
RELIEFWEB_APPNAME=your-app-identifier

# Social media (optional — disable cron jobs in src/app.js if unused)
LINKEDIN_ACCESS_TOKEN=
LINKEDIN_REFRESH_TOKEN=
FB_PAGE_ACCESS_TOKEN=
FB_PAGE_ID=

# ICAO Job Monitor (optional, currently disabled in app.js)
MONITOR_EMAIL_USER=
MONITOR_EMAIL_PASS=
MONITOR_RECIPIENT_EMAIL=

# Puppeteer (only for non-default Chrome paths)
PUPPETEER_EXECUTABLE_PATH=
CHROME_BIN=
```

### Initialize the database

```bash
node setup-database.js
```

This runs the schema in `src/etl/database-schema.sql` (creates `job_vacancies`, `etl_status`, `organization`, etc.).

### Run

```bash
npm run dev      # nodemon, hot reload
npm start        # plain node — what production runs
```

The API is now available at `http://localhost:3000/api/v1` and Swagger UI is at `http://localhost:3000/api/v1`.

> **Heads up**: `runEtl()` runs once on every server start, then on cron. If you don't want a full scrape on every restart, comment out the initial call in `src/app.js`.

## API overview

All endpoints are mounted under `/api/v1`. Most require `Authorization: Bearer <ACCESS_TOKEN_SECRET>`.

| Resource | Description |
|----------|-------------|
| `GET /jobs` | List job vacancies with filtering, pagination, search |
| `GET /jobs/:id` | Single job detail |
| `GET /organizations` | List of UN organizations / agencies |
| `GET /blogs` | Blog posts (public; falls back to unauthenticated reads) |
| `GET /etl` | ETL status dashboard |

Full docs live at `/api/v1` (Swagger UI) once the server is running.

## Scheduled jobs

All times are in the server's local timezone.

| Cron | What runs |
|------|-----------|
| `0 5 * * *` | Daily ReliefWeb ingestion |
| `0 6 * * *` | Full ETL run (all 12 in-app agencies) |
| `0 18 * * *` | Full ETL run (all 12 in-app agencies) |
| `0 7 * * *` | Post expiring-soon jobs to LinkedIn + Facebook |
| `0 8`–`0 20 * * *` | One job-network category per hour to LinkedIn + Facebook |

Social-media logic lives in `src/etl/social-media.js`. LinkedIn posts first; if it auto-cross-posts to Facebook, the Facebook step is skipped. Expired LinkedIn tokens trigger a refresh-and-retry when `LINKEDIN_REFRESH_TOKEN` is set.

## Operational scripts

These are ad-hoc tools, not unit tests — they hit the live database. Run with `node <file>.js`.

| Script | Purpose |
|--------|---------|
| `npm run job-monitor` | Standalone ICAO job monitor |
| `npm run run-reliefweb-etl` | Run ReliefWeb ETL ad hoc |
| `npm run test-job-monitor` | Smoke-test the monitor's email pipeline |
| `node force-cleanup-etl-locks.js` | Manually clear stuck `running` ETL locks |
| `node setup-database.js` | First-time schema setup |
| `node run-<agency>-etl.js` | Run a single agency's ETL outside the cron |

## Deployment

### Render (production)

The repo ships with `render.yaml`, `Dockerfile.render`, and `render-build.sh`. Puppeteer needs Chrome installed at build time — see `RENDER_DEPLOYMENT.md` and `DEPLOYMENT_GUIDE.md` for the system packages and `PUPPETEER_EXECUTABLE_PATH` glob.

### Docker (local)

```bash
docker compose up --build
```

Uses `Dockerfile` + `docker-compose.yml`.

## Adding a new agency

1. Create `src/etl/etl-<agency>.js` exporting `fetchAndProcess<Agency>JobVacancies()` that returns `{ success, processedCount, successCount, errorCount }`.
2. Import it in `src/app.js` and register it in the `etlJobs` array.
3. Add a row for the agency to the `organization` table.
4. Use `acquireETLLock`, `logETLStatus`, `upsertJobVacancy`, and `cleanupExpiredAndDuplicateJobs` from `src/etl/shared.js` — don't reimplement them.

## Project structure

```
src/
├── app.js                    # Entry point: server + cron + ETL orchestrator
├── instrument.js             # Sentry init (must load before other imports)
├── etl/
│   ├── etl-<agency>.js       # One module per data source
│   ├── etl-reliefweb.js      # Standalone, separate cron
│   ├── shared.js             # Locks, status logging, cleanup, upsert
│   ├── social-media.js       # LinkedIn + Facebook posters
│   ├── db.js                 # Postgres pool used by ETL code
│   └── database-schema.sql
├── routers/                  # Express routers (jobs, organizations, blogs, etl)
├── middleware/auth.js        # Static bearer / optional JWT / rate limiter
├── util/db.js                # Postgres pool used by controllers (separate from etl/db.js)
├── job-monitor.js            # Standalone ICAO HCM diff watcher (currently disabled)
└── redisClient.js
```

## Caveats & gotchas

- The `auth` middleware is a **static-string bearer check**, not JWT — despite the `jsonwebtoken` import. Don't assume token rotation.
- Rate limiting (`rateLimiter`) is in-memory and not multi-instance safe.
- ETL locks are per-organization but assume a single server instance.
- Two `db.js` files exist (`src/etl/db.js` and `src/util/db.js`); ETL code uses the former, controllers the latter.
- `runEtl()` runs on every server start — restarting the API in prod triggers a full scrape.

## Contributing

Contributions are welcome — bug fixes, new agencies, better scrapers, tests, docs.

1. Fork the repo and create a feature branch (`git checkout -b feature/my-thing`)
2. Keep changes focused and add notes to the PR about how you tested them
3. For scraper changes, include before/after counts of jobs successfully ingested
4. Open a PR

## License

ISC — see `LICENSE`.

## Author

[Yonas Yeneneh](mailto:expertsanoy@gmail.com)
