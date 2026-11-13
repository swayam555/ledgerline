import os

os.environ.setdefault("LEDGERLINE_AUTO_MIGRATE", "0")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from ledgerline.api import app
from ledgerline.db import Base, get_db, make_engine


@pytest.fixture()
def engine(tmp_path):
    # LEDGERLINE_TEST_DATABASE_URL=postgresql://... runs the same suite against Postgres
    url = os.getenv("LEDGERLINE_TEST_DATABASE_URL")
    if url:
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    eng = make_engine(url or f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture()
def client(engine):
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def _db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture()
def event():
    counter = iter(range(1, 10**6))

    def make(**kw):
        n = next(counter)
        base = {"event_id": f"evt_{n}", "event_type": "payment_initiated", "transaction_id": "txn_1",
                "merchant_id": "mer_a", "merchant_name": "Alpha Stores", "amount": 1500.5, "currency": "INR",
                "timestamp": "2026-11-01T10:00:00+00:00"}
        base.update(kw)
        return base

    return make
