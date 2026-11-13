"""Sample data: `ledgerline-generate` writes a realistic event file, `ledgerline-seed` replays it into a server."""
import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

MERCHANTS = [
    ("mer_kirana", "Kirana Kart"),
    ("mer_chai", "Chai Sutra"),
    ("mer_pages", "PageTurner Books"),
    ("mer_arcade", "Pixel Arcade"),
    ("mer_stride", "Stride Sports"),
]


def generate(scale: float = 1.0, seed: int | None = None, days: int = 30) -> list[dict]:
    """Event mix: clean settlements, declines, payments still waiting to settle (older ones become
    "stuck"), failed-then-settled anomalies, double settlements, plus re-delivered duplicates,
    all shuffled to mimic out-of-order webhook delivery."""
    rnd = random.Random(seed)
    start = datetime.now(timezone.utc) - timedelta(days=days)
    events: list[dict] = []

    def txn(steps: list[tuple[str, timedelta]], window_days: float = days - 2):
        tid = f"txn_{uuid.UUID(int=rnd.getrandbits(128)).hex[:20]}"
        mid, name = rnd.choice(MERCHANTS)
        amount = round(rnd.uniform(49, 50000), 2)
        t0 = start + timedelta(seconds=rnd.uniform(0, window_days * 86400))
        for etype, offset in steps:
            events.append({
                "event_id": f"evt_{uuid.UUID(int=rnd.getrandbits(128)).hex[:24]}", "event_type": etype,
                "transaction_id": tid, "merchant_id": mid, "merchant_name": name, "amount": amount,
                "currency": "INR", "timestamp": (t0 + offset).isoformat(),
            })

    n = lambda k: max(1, int(k * scale))  # noqa: E731
    s, sec, day = timedelta(0), timedelta(seconds=1), timedelta(days=1)
    for _ in range(n(3000)):
        txn([("payment_initiated", s), ("payment_processed", 4 * sec), ("settled", day)])
    for _ in range(n(500)):
        txn([("payment_initiated", s), ("payment_failed", 3 * sec)])
    for _ in range(n(500)):
        # spread over the whole window, so the most recent ones are still within the stuck threshold
        txn([("payment_initiated", s), ("payment_processed", 5 * sec)], window_days=days - 0.05)
    for _ in range(n(100)):
        txn([("payment_initiated", s), ("payment_failed", 5 * sec), ("settled", day)])
    for _ in range(n(40)):
        txn([("payment_initiated", s), ("payment_processed", 5 * sec), ("settled", day), ("settled", day + 90 * sec)])
    events.extend(rnd.sample(events, min(len(events), n(500))))  # partner retries
    rnd.shuffle(events)
    return events


def generate_main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Write sample payment events to a JSON file.")
    ap.add_argument("-o", "--out", default="sample_events.json")
    ap.add_argument("--scale", type=float, default=1.0, help="1.0 = ~11,600 events")
    ap.add_argument("--seed", type=int)
    a = ap.parse_args(argv)
    events = generate(a.scale, a.seed)
    with open(a.out, "w") as f:
        json.dump(events, f, indent=1)
    print(f"wrote {len(events):,} events for {len({e['transaction_id'] for e in events}):,} transactions to {a.out}")


def _post(url: str, payload) -> tuple[int, dict]:
    req = urllib.request.Request(url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def seed_main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Replay an event file into a running Ledgerline server.")
    ap.add_argument("file", nargs="?", default="sample_events.json")
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--one-by-one", action="store_true", help="POST /events per event (exercises idempotency under concurrency)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--batch", type=int, default=500)
    a = ap.parse_args(argv)
    with open(a.file) as f:
        events = json.load(f)
    base, t0 = a.url.rstrip("/"), time.perf_counter()
    accepted = dupes = failed = 0
    if a.one_by_one:
        with ThreadPoolExecutor(a.workers) as pool:
            for code, body in pool.map(lambda e: _post(f"{base}/events", e), events):
                if code != 200:
                    failed += 1
                elif body.get("duplicate"):
                    dupes += 1
                else:
                    accepted += 1
    else:
        for i in range(0, len(events), a.batch):
            code, body = _post(f"{base}/events/batch", events[i:i + a.batch])
            if code != 200:
                sys.exit(f"batch {i // a.batch} failed with HTTP {code}: {body}")
            accepted, dupes, failed = accepted + body["accepted"], dupes + body["duplicates"], failed + len(body["rejected"])
            print(f"\r{min(i + a.batch, len(events)):,}/{len(events):,} events", end="", flush=True)
        print()
    took = time.perf_counter() - t0
    print(f"{accepted:,} new, {dupes:,} duplicates ignored, {failed:,} rejected in {took:.1f}s ({len(events) / took:,.0f} events/s)")
