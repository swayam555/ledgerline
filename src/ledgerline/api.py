from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from . import __version__, service
from .config import settings
from .db import engine, get_db
from .migrate import upgrade
from .schemas import (BatchResult, Discrepancies, EventAck, EventIn, EventType, SortBy, SortOrder, SummaryRow,
                      TransactionDetail, TransactionOut)

STATIC = Path(__file__).parent / "static"
DB = Annotated[Session, Depends(get_db)]
PAGES = ("events", "transactions", "transaction", "summary", "discrepancies")


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.auto_migrate:
        upgrade()
    yield


app = FastAPI(title="Ledgerline", version=__version__, lifespan=lifespan,
              description="Ingests payment lifecycle events idempotently, tracks each transaction's state and reports "
                          "what doesn't reconcile.")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------------------------------------------------------------- UI (one shell, client-side pages)
@app.get("/", include_in_schema=False)
def ui_home():
    return FileResponse(STATIC / "index.html")


@app.get("/ui/{page}", include_in_schema=False)
def ui_page(page: str):
    if page not in PAGES:
        raise HTTPException(404, "Page not found")
    return FileResponse(STATIC / "index.html")


# ---------------------------------------------------------------- API
@app.get("/health", tags=["system"])
def health(db: DB):
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok", "database": engine.dialect.name, "version": __version__}
    except Exception as exc:  # pragma: no cover - only when the database is down
        raise HTTPException(503, {"status": "degraded", "database": engine.dialect.name, "error": type(exc).__name__})


@app.post("/events", response_model=EventAck, tags=["events"])
def ingest_event(event: EventIn, db: DB, response: Response):
    """Ingest one payment lifecycle event. Idempotent on `event_id`: re-sending an event returns
    `200` with `duplicate: true` and changes nothing."""
    ack = service.ingest(db, event)
    if ack.duplicate:
        response.headers["Ledgerline-Duplicate"] = "true"
    return ack


_event = TypeAdapter(EventIn)
MAX_BATCH = 1000


@app.post("/events/batch", response_model=BatchResult, tags=["events"])
def ingest_batch(events: list[dict], db: DB):
    """Ingest up to 1000 events in one request (handy for backfills). Each event is validated and
    ingested on its own, so one bad event doesn't reject the rest; it is listed in `rejected`."""
    if len(events) > MAX_BATCH:
        raise HTTPException(413, f"At most {MAX_BATCH} events per batch")
    valid: list[EventIn] = []
    rejected: list[dict] = []
    for i, raw in enumerate(events):
        try:
            valid.append(_event.validate_python(raw))
        except ValidationError as exc:
            rejected.append({"index": i, "event_id": raw.get("event_id") if isinstance(raw, dict) else None,
                             "errors": [f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()]})
    acks = service.ingest_many(db, valid) if valid else []
    duplicates = sum(a.duplicate for a in acks)
    accepted = len(acks) - duplicates
    return BatchResult(received=len(events), accepted=accepted, duplicates=duplicates, rejected=rejected)


@app.get("/transactions", response_model=list[TransactionOut], tags=["transactions"])
def list_transactions(
    db: DB, response: Response,
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1)] = 100,
    merchant_id: str | None = None,
    status: EventType | None = None,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    sort_by: SortBy = "updated_at",
    sort_order: SortOrder = "desc",
):
    """List transactions with filters, sorting and paging. The total match count is in `X-Total-Count`."""
    start = _naive(start_date)
    end = _naive(end_date)
    if start and end and start > end:
        raise HTTPException(422, "start_date must be on or before end_date")
    rows, total = service.list_transactions(db, skip=skip, limit=min(limit, settings.max_page_size), merchant_id=merchant_id,
                                            status=status, start=start, end=end, sort_by=sort_by, sort_order=sort_order)
    response.headers["X-Total-Count"] = str(total)
    return rows


@app.get("/transactions/{transaction_id}", response_model=TransactionDetail, tags=["transactions"])
def get_transaction(transaction_id: str, db: DB):
    """One transaction with its merchant, full event history and any reconciliation flags."""
    t = service.get_transaction(db, transaction_id.strip())
    if t is None:
        raise HTTPException(404, "Transaction not found")
    out = TransactionDetail.model_validate(t)
    out.flags = service.flags_for(t, settings.stuck_after_hours)
    return out


@app.get("/merchants", tags=["transactions"])
def merchants(db: DB):
    return service.merchants(db)


@app.get("/reconciliation/summary", response_model=list[SummaryRow], tags=["reconciliation"])
def reconciliation_summary(db: DB, merchant_id: str | None = None, status: EventType | None = None,
                           start_date: datetime | None = None, end_date: datetime | None = None):
    """Transaction counts and amounts grouped by date, merchant and status (aggregated in SQL)."""
    return service.summary(db, merchant_id=merchant_id, status=status, start=_naive(start_date), end=_naive(end_date))


@app.get("/reconciliation/discrepancies", response_model=Discrepancies, tags=["reconciliation"])
def reconciliation_discrepancies(db: DB):
    """Transactions whose history doesn't add up:
    - **failed_but_settled**: settled, but a `payment_failed` event was also received
    - **stuck_transactions**: still initiated/processed long after they started
    - **conflicting_transitions**: more than one terminal event (settled / failed)"""
    return service.discrepancies(db, settings.stuck_after_hours)


@app.get("/reconciliation/overview", tags=["reconciliation"])
def reconciliation_overview(db: DB):
    """Headline numbers for the dashboard."""
    return service.overview(db, settings.stuck_after_hours)


def _naive(v: datetime | None) -> datetime | None:
    from .schemas import _utc_naive
    return _utc_naive(v) if v else None


def main() -> None:
    import uvicorn
    uvicorn.run("ledgerline.api:app", host=settings.host, port=settings.port, proxy_headers=True)
