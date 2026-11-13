"""Ingestion and reconciliation queries. All aggregation happens in SQL."""
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import Select, exists, func, select, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, joinedload, selectinload

from . import models as m
from .schemas import EventAck, EventIn


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _insert(db: Session, table):
    return (pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert)(table)


def _ack(ev: m.Event, status: str, duplicate: bool) -> EventAck:
    return EventAck(event_id=ev.id, event_type=ev.event_type, transaction_id=ev.transaction_id,
                    timestamp=ev.occurred_at, received_at=ev.received_at, duplicate=duplicate, transaction_status=status)


def _existing(db: Session, event_id: str) -> EventAck | None:
    row = db.execute(select(m.Event, m.Transaction.status).join(m.Transaction).where(m.Event.id == event_id)).first()
    return _ack(row[0], row[1], True) if row else None


def _apply(db: Session, e: EventIn) -> EventAck | None:
    """Write one event inside the current transaction. Every write is an INSERT ... ON CONFLICT DO NOTHING
    or a guarded UPDATE, so concurrent deliveries can't double-apply. Returns None if an identical
    event_id won the race (the caller rolls back and reports a duplicate)."""
    ts, now = e.timestamp, utcnow()
    db.execute(_insert(db, m.Merchant).values(id=e.merchant_id, name=e.merchant_name).on_conflict_do_nothing())
    created = db.execute(
        _insert(db, m.Transaction).values(
            id=e.transaction_id, merchant_id=e.merchant_id, amount=e.amount, currency=e.currency,
            status=e.event_type, created_at=ts, updated_at=ts,
        ).on_conflict_do_nothing().returning(m.Transaction.id)
    ).first() is not None
    inserted = db.execute(
        _insert(db, m.Event).values(id=e.event_id, transaction_id=e.transaction_id, event_type=e.event_type,
                                    occurred_at=ts, received_at=now)
        .on_conflict_do_nothing().returning(m.Event.id)
    ).first() is not None
    if not inserted:
        return None
    status = e.event_type
    if not created:
        T = m.Transaction
        # the newest event decides the status, so late deliveries of older events don't roll it back
        status = db.scalar(update(T).where(T.id == e.transaction_id, T.updated_at <= ts)
                           .values(status=e.event_type, updated_at=ts).returning(T.status)) \
            or db.scalar(select(T.status).where(T.id == e.transaction_id))
        db.execute(update(T).where(T.id == e.transaction_id, T.created_at > ts).values(created_at=ts))
    return EventAck(event_id=e.event_id, event_type=e.event_type, transaction_id=e.transaction_id,
                    timestamp=ts, received_at=now, duplicate=False, transaction_status=status)


def _retrying(fn):
    """Deadlocks / lock timeouts are safe to retry because ingestion is idempotent."""
    for attempt in range(4):
        try:
            return fn()
        except OperationalError as exc:
            msg = str(exc.orig).lower()
            if attempt == 3 or not ("deadlock" in msg or "locked" in msg or "could not serialize" in msg):
                raise
            time.sleep(0.05 * (attempt + 1))


def ingest(db: Session, e: EventIn) -> EventAck:
    """Record one lifecycle event; re-sending the same event_id is a no-op that reports duplicate=True."""
    def run():
        try:
            if (dup := _existing(db, e.event_id)) is not None:
                return dup
            ack = _apply(db, e)
            if ack is None:  # lost a race with an identical delivery
                db.rollback()
                return _existing(db, e.event_id)
            db.commit()
            return ack
        except Exception:
            db.rollback()
            raise
    return _retrying(run)


def ingest_many(db: Session, events: list[EventIn]) -> list[EventAck]:
    """Ingest a batch in one database transaction (a savepoint per event), which is much faster than
    committing each event. The whole batch is retried on a deadlock; already-applied events become duplicates."""
    def run():
        acks: list[EventAck] = []
        try:
            for e in events:
                if (dup := _existing(db, e.event_id)) is not None:
                    acks.append(dup)
                    continue
                sp = db.begin_nested()
                ack = _apply(db, e)
                if ack is None:
                    sp.rollback()
                    acks.append(_existing(db, e.event_id))  # type: ignore[arg-type]
                else:
                    sp.commit()
                    acks.append(ack)
            db.commit()
            return acks
        except Exception:
            db.rollback()
            raise
    return _retrying(run)


# ---------------------------------------------------------------- transactions
def _filtered(stmt: Select, merchant_id, status, start, end) -> Select:
    T = m.Transaction
    if merchant_id:
        stmt = stmt.where(T.merchant_id == merchant_id)
    if status:
        stmt = stmt.where(T.status == status)
    if start:
        stmt = stmt.where(T.created_at >= start)
    if end:
        stmt = stmt.where(T.created_at <= end)
    return stmt


def list_transactions(db: Session, *, skip=0, limit=100, merchant_id=None, status=None, start=None, end=None,
                      sort_by="updated_at", sort_order="desc") -> tuple[list[m.Transaction], int]:
    T = m.Transaction
    col = {"amount": T.amount, "created_at": T.created_at}.get(sort_by, T.updated_at)
    order = [col.asc(), T.id.asc()] if sort_order == "asc" else [col.desc(), T.id.desc()]
    rows = db.scalars(_filtered(select(T), merchant_id, status, start, end).order_by(*order).offset(skip).limit(limit)).all()
    total = db.scalar(_filtered(select(func.count()).select_from(T), merchant_id, status, start, end)) or 0
    return list(rows), total


def get_transaction(db: Session, txn_id: str) -> m.Transaction | None:
    # one query for the transaction + merchant, one for its events
    return db.scalar(select(m.Transaction).options(joinedload(m.Transaction.merchant), selectinload(m.Transaction.events))
                     .where(m.Transaction.id == txn_id))


def flags_for(t: m.Transaction, stuck_after_hours: float) -> list[str]:
    types = [e.event_type for e in t.events]
    out = []
    if t.status == "settled" and "payment_failed" in types:
        out.append("failed_but_settled")
    if t.status in m.IN_FLIGHT and t.created_at < utcnow() - timedelta(hours=stuck_after_hours):
        out.append("stuck")
    if sum(x in m.TERMINAL for x in types) > 1:
        out.append("conflicting_transitions")
    return out


def merchants(db: Session) -> list[dict]:
    T = m.Transaction
    rows = db.execute(select(m.Merchant.id, m.Merchant.name, func.count(T.id)).outerjoin(T).group_by(m.Merchant.id, m.Merchant.name)
                      .order_by(m.Merchant.id)).all()
    return [{"id": i, "name": n, "transactions": c} for i, n, c in rows]


# ---------------------------------------------------------------- reconciliation
def summary(db: Session, *, merchant_id=None, status=None, start=None, end=None) -> list[dict]:
    T = m.Transaction
    day = func.date(T.created_at).label("date")
    stmt = (select(day, T.merchant_id, m.Merchant.name, T.status, T.currency, func.count(T.id), func.coalesce(func.sum(T.amount), 0))
            .join(m.Merchant).group_by(day, T.merchant_id, m.Merchant.name, T.status, T.currency)
            .order_by(day.desc(), T.merchant_id, T.status, T.currency))
    rows = db.execute(_filtered(stmt, merchant_id, status, start, end)).all()
    return [{"date": d if not isinstance(d, str) else datetime.fromisoformat(d).date(), "merchant_id": mid, "merchant_name": name,
             "status": st, "currency": cur, "total_transactions": n, "total_amount": float(amt)}
            for d, mid, name, st, cur, n, amt in rows]


def discrepancies(db: Session, stuck_after_hours: float) -> dict:
    T, E = m.Transaction, m.Event
    failed_but_settled = db.scalars(
        select(T).where(T.status == "settled", exists().where(E.transaction_id == T.id, E.event_type == "payment_failed"))
        .order_by(T.updated_at.desc())).all()
    stuck = db.scalars(
        select(T).where(T.status.in_(m.IN_FLIGHT), T.created_at < utcnow() - timedelta(hours=stuck_after_hours))
        .order_by(T.created_at.asc())).all()
    terminal_count = (select(E.transaction_id).where(E.event_type.in_(m.TERMINAL))
                      .group_by(E.transaction_id).having(func.count(E.id) > 1).subquery())
    conflicting = db.scalars(select(T).join(terminal_count, terminal_count.c.transaction_id == T.id).order_by(T.updated_at.desc())).all()
    return {"stuck_after_hours": stuck_after_hours, "failed_but_settled": list(failed_but_settled),
            "stuck_transactions": list(stuck), "conflicting_transitions": list(conflicting)}


def overview(db: Session, stuck_after_hours: float) -> dict:
    """Headline numbers. Amounts are kept per currency; they are never added across currencies."""
    T = m.Transaction
    by_status: dict[str, dict] = {}
    amounts: dict[str, dict] = {}
    for st, cur, n, amt in db.execute(select(T.status, T.currency, func.count(T.id), func.coalesce(func.sum(T.amount), 0)).group_by(T.status, T.currency)):
        b = by_status.setdefault(st, {"count": 0, "amounts": {}})
        b["count"] += n
        b["amounts"][cur] = float(amt)
        a = amounts.setdefault(cur, {"total": 0.0, "settled": 0.0, "transactions": 0})
        a["total"] += float(amt)
        a["transactions"] += n
        if st == "settled":
            a["settled"] += float(amt)
    d = discrepancies(db, stuck_after_hours)
    return {
        "transactions": sum(b["count"] for b in by_status.values()),
        "events": db.scalar(select(func.count(m.Event.id))) or 0,
        "merchants": db.scalar(select(func.count(m.Merchant.id))) or 0,
        "currencies": dict(sorted(amounts.items(), key=lambda kv: -kv[1]["transactions"])),
        "by_status": dict(sorted(by_status.items())),
        "discrepancies": {k: len(d[k]) for k in ("failed_but_settled", "stuck_transactions", "conflicting_transitions")},
        "last_event_at": db.scalar(select(func.max(m.Event.received_at))),
    }
