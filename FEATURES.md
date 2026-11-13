# Feature map

This file lists every feature of the reference design Ledgerline was built to cover: a payment reconciliation service with FastAPI, SQLAlchemy, Alembic, PostgreSQL or SQLite, data generator and seeder scripts, and a static HTML console. For each feature it shows where Ledgerline implements it and how it was tested.

Tests are marked:
- **T**: pytest (`uv run pytest`, 19 tests, passing on SQLite and Postgres);
- **B**: checked by hand in the browser;
- **A**: checked by hand against the live API or CLI.

## API

| Reference feature | In Ledgerline | Tested |
|---|---|---|
| `GET /health` | Same, and it reports which database is in use | T, A |
| `POST /events`, idempotent on `event_id` (a duplicate returns `200` with the existing event) | Same, plus `"duplicate": true` and a `Ledgerline-Duplicate: true` header. Concurrent duplicates also resolve to one event | T, A, B |
| — | `POST /events/batch`: up to 1,000 events in one transaction. Invalid ones are listed in `rejected` and the rest are applied | T, A |
| Status updates from events (the reference had no transition rules) | The event with the latest timestamp sets the status, so a late delivery of an old event can't roll it back. Offsets like `+05:30` are normalised to UTC | T |
| `GET /transactions` with paging and `merchant_id`, `status` filters | Same, plus a created-date range, sorting by update time, created time or amount, and the total in `X-Total-Count` | T, B |
| `GET /transactions/{id}` with event history | Merchant, ordered events and reconciliation flags, loaded in two queries | T, B |
| — | `GET /merchants`, `GET /reconciliation/overview` | T, B |
| `GET /reconciliation/summary` grouped by date, merchant and status in SQL | Same, also grouped by currency, with the list's filters. Amounts are never summed across currencies | T, B |
| `GET /reconciliation/discrepancies`: failed but settled, stuck in pending | Same two, plus `conflicting_transitions` (more than one terminal event). The stuck limit is `LEDGERLINE_STUCK_HOURS` (48) | T, B |
| Pydantic validation | Known event types only; positive amounts with at most 2 decimals; 3-letter currency; IDs limited in characters and length; `422` errors per field | T, B |

## Data and storage

| Reference feature | In Ledgerline | Tested |
|---|---|---|
| SQLite by default, PostgreSQL through `DATABASE_URL` | Same (`LEDGERLINE_DATABASE_URL` or `DATABASE_URL`) | T (both) |
| Alembic migrations, run automatically in Docker | Migrations run on startup unless `LEDGERLINE_AUTO_MIGRATE=0` | T |
| `generate_data.py`: over 11,000 events with 500 duplicates | `ledgerline-generate`: 11,960 events for 4,140 transactions, with 500 duplicates, shuffled | T, A |
| `seed_data.py`: replay through `POST /events` | `ledgerline-seed` uses the batch endpoint by default, or `--one-by-one --workers N` for concurrent single posts. A retest ingested 11,460 new events and ignored exactly 500 duplicates | A |
| Docker Compose with Postgres | Same, on `:8000` | A |
| Postman collection | `ledgerline.postman_collection.json` | — |

## Console

| Reference page | In Ledgerline | Tested |
|---|---|---|
| `index.html` (dashboard) | Dashboard `/`: totals, settled amount, discrepancies, status breakdown, endpoint list | B |
| `events.html` (send an event) | Ingest `/ui/events`: a form with a sample fill, "next event for this transaction", field errors and the raw response, or upload a JSON file of events | B |
| `transactions.html` | Transactions `/ui/transactions`: merchant, status and date filters, sorting, shareable URLs | B |
| `transaction.html` | Lookup `/ui/transaction?id=…`: lifecycle, flags and full event history, including late deliveries | B |
| `summary.html` | Summary `/ui/summary`: grouping, totals and CSV export | B |
| `discrepancies.html` | Discrepancies `/ui/discrepancies`: the three lists, each with an explanation and a suggested action | B |
| Responsive layout | Every page checked at 390 px with no sideways scroll | B |
