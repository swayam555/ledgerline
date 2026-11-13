from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from ledgerline.tools import generate


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_ingest_creates_transaction_merchant_and_event(client, event):
    r = client.post("/events", json=event())
    assert r.status_code == 200
    body = r.json()
    assert body["duplicate"] is False and body["transaction_status"] == "payment_initiated"
    t = client.get("/transactions/txn_1").json()
    assert t["status"] == "payment_initiated" and t["amount"] == 1500.5 and t["currency"] == "INR"
    assert t["merchant"] == {"id": "mer_a", "name": "Alpha Stores"}
    assert [e["event_type"] for e in t["events"]] == ["payment_initiated"]


def test_duplicate_event_is_ignored(client, event):
    e = event()
    client.post("/events", json=e)
    changed = {**e, "event_type": "settled", "amount": 9}  # same id, different payload: still a duplicate
    r = client.post("/events", json=changed)
    assert r.status_code == 200
    assert r.json()["duplicate"] is True and r.json()["event_type"] == "payment_initiated"
    assert r.headers["ledgerline-duplicate"] == "true"
    t = client.get("/transactions/txn_1").json()
    assert len(t["events"]) == 1 and t["status"] == "payment_initiated" and t["amount"] == 1500.5


def test_concurrent_duplicates_store_one_event(client, event):
    e = event()
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda _: client.post("/events", json=e), range(16)))
    assert all(r.status_code == 200 for r in results)
    assert sum(not r.json()["duplicate"] for r in results) == 1
    assert len(client.get("/transactions/txn_1").json()["events"]) == 1


def test_concurrent_events_for_new_transaction(client, event):
    evs = [event(event_type=t, timestamp=f"2026-11-01T10:00:0{i}+00:00")
           for i, t in enumerate(["payment_initiated", "payment_processed", "settled"])]
    with ThreadPoolExecutor(3) as pool:
        results = list(pool.map(lambda e: client.post("/events", json=e), evs))
    assert [r.status_code for r in results] == [200, 200, 200]
    t = client.get("/transactions/txn_1").json()
    assert t["status"] == "settled" and len(t["events"]) == 3


def test_out_of_order_events_keep_latest_status(client, event):
    client.post("/events", json=event(event_type="settled", timestamp="2026-11-02T10:00:00Z"))
    client.post("/events", json=event(event_type="payment_initiated", timestamp="2026-11-01T10:00:00Z"))
    client.post("/events", json=event(event_type="payment_processed", timestamp="2026-11-01T10:00:05Z"))
    t = client.get("/transactions/txn_1").json()
    assert t["status"] == "settled"
    assert t["created_at"].startswith("2026-11-01T10:00:00") and t["updated_at"].startswith("2026-11-02T10:00:00")
    assert [e["event_type"] for e in t["events"]] == ["payment_initiated", "payment_processed", "settled"]


def test_timestamps_are_normalised_to_utc(client, event):
    client.post("/events", json=event(timestamp="2026-11-01T15:30:00+05:30"))
    assert client.get("/transactions/txn_1").json()["created_at"].startswith("2026-11-01T10:00:00")


def test_validation_errors(client, event):
    bad = [
        event(event_type="refunded"), event(amount=-5), event(amount=0), event(amount=10.123),
        event(currency="RUPEE"), event(timestamp="yesterday"), event(event_id=""), event(transaction_id="has space"),
    ]
    for b in bad:
        assert client.post("/events", json=b).status_code == 422, b
    missing = event()
    del missing["merchant_name"]
    assert client.post("/events", json=missing).status_code == 422
    assert client.get("/transactions").json() == []


def test_currency_is_uppercased(client, event):
    client.post("/events", json=event(currency="usd"))
    assert client.get("/transactions/txn_1").json()["currency"] == "USD"


def _seed_list(client, event):
    rows = [("t1", "mer_a", 100, "settled", "2026-11-01"), ("t2", "mer_a", 300, "payment_failed", "2026-11-02"),
            ("t3", "mer_b", 200, "settled", "2026-11-03"), ("t4", "mer_b", 50, "payment_processed", "2026-11-04")]
    for tid, mid, amt, st, d in rows:
        client.post("/events", json=event(transaction_id=tid, merchant_id=mid, merchant_name=mid.upper(), amount=amt,
                                          event_type=st, timestamp=f"{d}T12:00:00Z"))


def test_list_filters_sorting_and_paging(client, event):
    _seed_list(client, event)
    r = client.get("/transactions")
    assert r.headers["x-total-count"] == "4" and [t["id"] for t in r.json()] == ["t4", "t3", "t2", "t1"]
    assert [t["id"] for t in client.get("/transactions?merchant_id=mer_b").json()] == ["t4", "t3"]
    assert [t["id"] for t in client.get("/transactions?status=settled").json()] == ["t3", "t1"]
    assert [t["id"] for t in client.get("/transactions?sort_by=amount&sort_order=asc").json()] == ["t4", "t1", "t3", "t2"]
    r = client.get("/transactions?start_date=2026-11-02T00:00:00&end_date=2026-11-03T23:59:59&sort_by=created_at&sort_order=asc")
    assert [t["id"] for t in r.json()] == ["t2", "t3"] and r.headers["x-total-count"] == "2"
    r = client.get("/transactions?skip=1&limit=2")
    assert [t["id"] for t in r.json()] == ["t3", "t2"] and r.headers["x-total-count"] == "4"
    assert client.get("/transactions?sort_by=nope").status_code == 422
    assert client.get("/transactions?status=nope").status_code == 422
    assert client.get("/transactions?limit=0").status_code == 422
    assert client.get("/transactions?start_date=2026-11-05T00:00:00&end_date=2026-11-01T00:00:00").status_code == 422


def test_transaction_not_found(client):
    assert client.get("/transactions/missing").status_code == 404


def test_summary_groups_by_date_merchant_status(client, event):
    _seed_list(client, event)
    client.post("/events", json=event(transaction_id="t5", merchant_id="mer_a", merchant_name="MER_A", amount=0.5,
                                      event_type="settled", timestamp="2026-11-01T18:00:00Z"))
    rows = client.get("/reconciliation/summary").json()
    day1 = [r for r in rows if r["date"] == "2026-11-01"]
    assert day1 == [{"date": "2026-11-01", "merchant_id": "mer_a", "merchant_name": "MER_A", "status": "settled",
                     "currency": "INR", "total_transactions": 2, "total_amount": 100.5}]
    assert len(rows) == 4
    assert {r["merchant_id"] for r in client.get("/reconciliation/summary?merchant_id=mer_b").json()} == {"mer_b"}


def test_discrepancies(client, event):
    old = datetime.now(timezone.utc) - timedelta(days=5)
    recent = datetime.now(timezone.utc) - timedelta(hours=2)
    # failed, then settled
    client.post("/events", json=event(transaction_id="fs", event_type="payment_initiated", timestamp=iso(old)))
    client.post("/events", json=event(transaction_id="fs", event_type="payment_failed", timestamp=iso(old + timedelta(seconds=5))))
    client.post("/events", json=event(transaction_id="fs", event_type="settled", timestamp=iso(old + timedelta(days=1))))
    # stuck in processed for days vs. a recent one that is fine
    client.post("/events", json=event(transaction_id="stuck", event_type="payment_processed", timestamp=iso(old)))
    client.post("/events", json=event(transaction_id="fresh", event_type="payment_processed", timestamp=iso(recent)))
    # settled twice
    client.post("/events", json=event(transaction_id="twice", event_type="settled", timestamp=iso(old)))
    client.post("/events", json=event(transaction_id="twice", event_type="settled", timestamp=iso(old + timedelta(minutes=2))))
    # clean
    client.post("/events", json=event(transaction_id="ok", event_type="settled", timestamp=iso(old)))

    d = client.get("/reconciliation/discrepancies").json()
    ids = lambda k: sorted(t["id"] for t in d[k])  # noqa: E731
    assert d["stuck_after_hours"] == 48
    assert ids("failed_but_settled") == ["fs"]
    assert ids("stuck_transactions") == ["stuck"]
    assert ids("conflicting_transitions") == ["fs", "twice"]
    assert client.get("/transactions/fs").json()["flags"] == ["failed_but_settled", "conflicting_transitions"]
    assert client.get("/transactions/stuck").json()["flags"] == ["stuck"]
    assert client.get("/transactions/ok").json()["flags"] == []

    o = client.get("/reconciliation/overview").json()
    assert o["transactions"] == 5 and o["merchants"] == 1 and o["events"] == 8
    assert o["discrepancies"] == {"failed_but_settled": 1, "stuck_transactions": 1, "conflicting_transitions": 2}


def test_batch_ingest_reports_each_event(client, event):
    good = event(transaction_id="b1")
    batch = [good, good, event(transaction_id="b2", event_type="settled"), {"event_id": "x"}, "not an object"]
    r = client.post("/events/batch", json=batch[:4])
    assert r.status_code == 200
    body = r.json()
    assert (body["received"], body["accepted"], body["duplicates"]) == (4, 2, 1)
    assert body["rejected"][0]["index"] == 3 and body["rejected"][0]["event_id"] == "x"
    assert client.post("/events/batch", json=[event()] * 1001).status_code == 413
    assert client.post("/events/batch", json=batch).status_code == 422  # non-object item


def test_generated_data_reconciles(client):
    events = generate(scale=0.05, seed=7)
    for i in range(0, len(events), 1000):
        assert client.post("/events/batch", json=events[i:i + 1000]).status_code == 200
    unique = {e["event_id"] for e in events}
    o = client.get("/reconciliation/overview").json()
    assert o["events"] == len(unique)
    assert o["transactions"] == len({e["transaction_id"] for e in events})
    assert o["merchants"] == 5
    d = o["discrepancies"]
    assert d["failed_but_settled"] == 5  # 100 * 0.05
    assert d["conflicting_transitions"] == 5 + 2  # failed+settled, plus settled twice
    assert d["stuck_transactions"] > 0
    # replaying the whole file changes nothing
    sample = events[:1000]
    again = client.post("/events/batch", json=sample).json()
    assert again["accepted"] == 0 and again["duplicates"] == len(sample)
    assert client.get("/reconciliation/overview").json()["events"] == len(unique)


def test_amounts_are_never_added_across_currencies(client, event):
    client.post("/events", json=event(transaction_id="a", amount=100, currency="INR", event_type="settled"))
    client.post("/events", json=event(transaction_id="b", amount=7, currency="USD", event_type="settled"))
    client.post("/events", json=event(transaction_id="c", amount=50, currency="INR", event_type="payment_processed"))
    o = client.get("/reconciliation/overview").json()
    assert o["currencies"] == {"INR": {"total": 150.0, "settled": 100.0, "transactions": 2},
                               "USD": {"total": 7.0, "settled": 7.0, "transactions": 1}}
    assert o["by_status"]["settled"] == {"count": 2, "amounts": {"INR": 100.0, "USD": 7.0}}
    rows = client.get("/reconciliation/summary").json()
    assert sorted((r["currency"], r["status"], r["total_amount"]) for r in rows) == [
        ("INR", "payment_processed", 50.0), ("INR", "settled", 100.0), ("USD", "settled", 7.0)]


def test_merchants_endpoint(client, event):
    _seed_list(client, event)
    assert client.get("/merchants").json() == [{"id": "mer_a", "name": "MER_A", "transactions": 2},
                                               {"id": "mer_b", "name": "MER_B", "transactions": 2}]


def test_ui_pages(client):
    for path in ["/", "/ui/events", "/ui/transactions", "/ui/transaction", "/ui/summary", "/ui/discrepancies"]:
        r = client.get(path)
        assert r.status_code == 200 and "text/html" in r.headers["content-type"], path
    assert client.get("/ui/nope").status_code == 404
    assert client.get("/static/app.js").status_code == 200
