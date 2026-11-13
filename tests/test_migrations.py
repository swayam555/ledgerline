from sqlalchemy import create_engine, inspect

from ledgerline.migrate import upgrade


def test_migrations_build_the_schema(tmp_path):
    url = f"sqlite:///{tmp_path / 'm.db'}"
    upgrade(url)
    upgrade(url)  # idempotent
    insp = inspect(create_engine(url))
    assert {"merchants", "transactions", "events", "alembic_version"} <= set(insp.get_table_names())
    assert {c["name"] for c in insp.get_columns("events")} == {"id", "transaction_id", "event_type", "occurred_at", "received_at"}
