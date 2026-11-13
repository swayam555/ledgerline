from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from .models import EVENT_TYPES

EventType = Literal["payment_initiated", "payment_processed", "payment_failed", "settled"]
assert set(EventType.__args__) == set(EVENT_TYPES)

Ident = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:\-]+$")]


def _two_places(v: Decimal) -> Decimal:
    if v.as_tuple().exponent < -2:  # type: ignore[operator]
        raise ValueError("amount can have at most 2 decimal places")
    return v


def _utc_naive(v: datetime) -> datetime:
    # everything is stored as naive UTC; timestamps without an offset are taken to be UTC already
    return v.astimezone(timezone.utc).replace(tzinfo=None) if v.tzinfo else v


class EventIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{
        "event_id": "evt_7f3a91", "event_type": "payment_initiated", "transaction_id": "txn_20491",
        "merchant_id": "merchant_2", "merchant_name": "FreshBasket", "amount": 1499.5, "currency": "INR",
        "timestamp": "2026-11-12T09:30:00+05:30"}]})

    event_id: Ident
    event_type: EventType
    transaction_id: Ident
    merchant_id: Ident
    merchant_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    amount: Annotated[Decimal, Field(gt=0, le=Decimal("999999999999.99")), AfterValidator(_two_places)]
    currency: Annotated[str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Za-z]{3}$")] = "INR"
    timestamp: Annotated[datetime, AfterValidator(_utc_naive)]


class EventAck(BaseModel):
    event_id: str
    event_type: str
    transaction_id: str
    timestamp: datetime
    received_at: datetime
    duplicate: bool = Field(description="True when this event_id was already ingested; nothing was changed")
    transaction_status: str


class BatchResult(BaseModel):
    received: int
    accepted: int
    duplicates: int
    rejected: list[dict]


class MerchantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    event_type: str
    timestamp: datetime = Field(validation_alias="occurred_at")
    received_at: datetime


class TransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    merchant_id: str
    amount: float
    currency: str
    status: str
    created_at: datetime
    updated_at: datetime


class TransactionDetail(TransactionOut):
    merchant: MerchantOut
    events: list[EventOut]
    flags: list[str] = Field(default_factory=list, description="Reconciliation problems found on this transaction")


class SummaryRow(BaseModel):
    date: date
    merchant_id: str
    merchant_name: str
    status: str
    currency: str
    total_transactions: int
    total_amount: float


class Discrepancies(BaseModel):
    stuck_after_hours: float
    failed_but_settled: list[TransactionOut]
    stuck_transactions: list[TransactionOut]
    conflicting_transitions: list[TransactionOut]


SortBy = Literal["updated_at", "created_at", "amount"]
SortOrder = Literal["asc", "desc"]
