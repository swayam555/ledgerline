# Ledgerline

Ledgerline is a payment-event ingestion and reconciliation service. Payment partners send lifecycle events (`payment_initiated → payment_processed → settled`, or `payment_failed`). Ledgerline then does four things:
- stores every event exactly once
- tracks the current state of each transaction
- reports totals by day, merchant and status
- flags transactions whose history doesn't add up

It comes with a web console for ingesting events, browsing transactions and working through discrepancies.

**Stack:** FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL (or SQLite with zero setup) · a vanilla JS console with no build step.

## How it behaves

- **Idempotent ingestion.** The partner's `event_id` is the primary key.
  - Re-sending an event returns `200` with `"duplicate": true` and a `Ledgerline-Duplicate: true` header. Nothing changes.
  - All writes are `INSERT … ON CONFLICT DO NOTHING` or guarded `UPDATE`s. This means concurrent duplicate deliveries also resolve to a single event; the tests cover this, and so does a 16-thread replay against Postgres.
- **Out-of-order safe.** The event with the latest timestamp decides a transaction's status, so a late delivery of an old event can't roll it back.
  - `created_at` is the earliest event seen and `updated_at` the latest.
  - Timestamps with offsets (`+05:30`) are normalised to UTC.
- **Nothing is discarded.** Contradictory histories are kept and surfaced by `GET /reconciliation/discrepancies`:
  - `failed_but_settled`: settled, but a `payment_failed` event was also received
  - `stuck_transactions`: still initiated or processed more than `LEDGERLINE_STUCK_HOURS` (48) after they started
  - `conflicting_transitions`: more than one terminal event (`settled` / `payment_failed`), for example a settlement reported twice
- **SQL does the heavy lifting.** Summaries are `GROUP BY` date, merchant, status and currency. Discrepancies are `EXISTS` and `HAVING` queries. A transaction's detail loads in two queries (no N+1).
- **Currencies are never mixed.** Amounts are summed per currency everywhere.
- **Validation.**
  - Known event types only.
  - Amounts must be positive, with at most 2 decimals.
  - Currency is a 3-letter code.
  - IDs are limited to `[A-Za-z0-9_.:-]`, 64 characters max.
  - Errors return `422` with field-level detail.

## Run it

**Docker (Postgres):**

```bash
docker compose up -d --build --wait          # http://localhost:8000
uv run ledgerline-generate                  # writes sample_events.json (~12k events, 500 duplicates, shuffled)
uv run ledgerline-seed                      # replays it via POST /events/batch
```

**Local (SQLite, no services needed):**

```bash
uv sync
uv run ledgerline                            # http://127.0.0.1:8000, creates ./ledgerline.db, runs migrations
uv run ledgerline-generate && uv run ledgerline-seed
```

`ledgerline-seed --one-by-one --workers 16` sends each event to `POST /events` concurrently instead. It is a good way to see the idempotency guarantees under load.

## Console

| Page | What you can do |
|---|---|
| **Dashboard** `/` | Transaction, amount, settled and discrepancy totals; a breakdown by current status; the endpoint list |
| **Ingest** `/ui/events` | Send a single event: sample fill, "next event for this transaction", field-level errors, raw response. Or upload a JSON file of events in batches of 500 |
| **Transactions** `/ui/transactions` | Filter by merchant, status and created-date range. Sort by update time, created time or amount. Pages are shareable URLs. Click a row for the history drawer |
| **Lookup** `/ui/transaction?id=…` | A transaction's lifecycle, flags, merchant and full event history, including late deliveries |
| **Summary** `/ui/summary` | Counts and amounts by day, merchant, status and currency, with totals, regrouping and CSV export |
| **Discrepancies** `/ui/discrepancies` | The three discrepancy lists, each with an explanation and a suggested action |

## API

Interactive docs are at `/docs`. A Postman collection is in `ledgerline.postman_collection.json`.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Database reachability |
| POST | `/events` | Ingest one event. Idempotent on `event_id` |
| POST | `/events/batch` | Up to 1000 events in one transaction. Invalid ones are listed in `rejected`; the rest are applied |
| GET | `/transactions` | `merchant_id, status, start_date, end_date, sort_by (updated_at\|created_at\|amount), sort_order, skip, limit`. Total in `X-Total-Count` |
| GET | `/transactions/{id}` | Merchant, ordered events, reconciliation `flags` |
| GET | `/merchants` | Merchants with transaction counts |
| GET | `/reconciliation/summary` | Grouped by date, merchant, status and currency; same filters as the list |
| GET | `/reconciliation/discrepancies` | The three lists above |
| GET | `/reconciliation/overview` | Dashboard totals |

Example event:

```json
{
  "event_id": "evt_7f3a91", "event_type": "payment_initiated", "transaction_id": "txn_20491",
  "merchant_id": "mer_chai", "merchant_name": "Chai Sutra", "amount": 1499.50, "currency": "INR",
  "timestamp": "2026-11-12T09:30:00+05:30"
}
```

## Configuration

| Variable | Default | |
|---|---|---|
| `LEDGERLINE_DATABASE_URL` (or `DATABASE_URL`) | `sqlite:///./ledgerline.db` | `postgresql://…` URLs are accepted as-is |
| `LEDGERLINE_STUCK_HOURS` | `48` | When an in-flight transaction counts as stuck |
| `LEDGERLINE_HOST` / `LEDGERLINE_PORT` (or `PORT`) | `127.0.0.1` / `8000` | |
| `LEDGERLINE_AUTO_MIGRATE` | `1` | Run Alembic migrations on startup |
| `LEDGERLINE_MAX_PAGE_SIZE` | `500` | Upper bound for `limit` |

Migrations are in `src/ledgerline/migrations`. To create a new one, run `uv run alembic revision --autogenerate -m "…"`.

## Tests

```bash
uv run pytest                                                            # SQLite
docker compose up -d postgres && docker compose exec postgres createdb -U ledgerline ledgerline_test
LEDGERLINE_TEST_DATABASE_URL=postgresql://ledgerline:ledgerline@127.0.0.1:5436/ledgerline_test uv run pytest
```

The tests cover:
- idempotency, including concurrent duplicates and concurrent events for a new transaction
- out-of-order delivery and timezone handling
- validation
- filters, sorting and paging
- summary grouping and per-currency totals
- all three discrepancy rules
- batch partial failure
- an end-to-end check that generated data reconciles to the expected counts
- migrations

## License

MIT
