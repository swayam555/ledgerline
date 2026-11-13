import os
from dataclasses import dataclass


def _db_url() -> str:
    url = os.getenv("LEDGERLINE_DATABASE_URL") or os.getenv("DATABASE_URL") or "sqlite:///./ledgerline.db"
    # plain postgres URLs (as given by most hosts) should use the psycopg 3 driver
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


@dataclass(frozen=True)
class Settings:
    database_url: str
    stuck_after_hours: float
    max_page_size: int
    host: str
    port: int
    auto_migrate: bool


def load() -> Settings:
    return Settings(
        database_url=_db_url(),
        stuck_after_hours=float(os.getenv("LEDGERLINE_STUCK_HOURS", "48")),
        max_page_size=int(os.getenv("LEDGERLINE_MAX_PAGE_SIZE", "500")),
        host=os.getenv("LEDGERLINE_HOST", "127.0.0.1"),
        port=int(os.getenv("LEDGERLINE_PORT", os.getenv("PORT", "8000"))),
        auto_migrate=os.getenv("LEDGERLINE_AUTO_MIGRATE", "1") != "0",
    )


settings = load()
