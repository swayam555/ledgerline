from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

# The lifecycle a payment goes through. Terminal events end it one way or the other.
EVENT_TYPES = ("payment_initiated", "payment_processed", "payment_failed", "settled")
TERMINAL = ("payment_failed", "settled")
IN_FLIGHT = ("payment_initiated", "payment_processed")


class Merchant(Base):
    __tablename__ = "merchants"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))

    transactions: Mapped[list["Transaction"]] = relationship(back_populates="merchant")


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    merchant_id: Mapped[str] = mapped_column(ForeignKey("merchants.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    status: Mapped[str] = mapped_column(String(32), index=True)
    # created_at = earliest event seen, updated_at = latest event seen (events may arrive out of order)
    created_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, index=True)

    merchant: Mapped[Merchant] = relationship(back_populates="transactions")
    events: Mapped[list["Event"]] = relationship(back_populates="transaction", order_by="(Event.occurred_at, Event.received_at)")

    __table_args__ = (Index("ix_transactions_merchant_status", "merchant_id", "status"),)


class Event(Base):
    __tablename__ = "events"

    # the partner's event id is the primary key, which is what makes ingestion idempotent
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    transaction_id: Mapped[str] = mapped_column(ForeignKey("transactions.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(32), index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime)

    transaction: Mapped[Transaction] = relationship(back_populates="events")
