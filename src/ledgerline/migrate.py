"""Run Alembic migrations from code (used at startup and by `python -m ledgerline.migrate`)."""
from pathlib import Path

from alembic import command
from alembic.config import Config

from .config import settings


def alembic_config(url: str | None = None) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", (url or settings.database_url).replace("%", "%%"))
    return cfg


def upgrade(url: str | None = None) -> None:
    command.upgrade(alembic_config(url), "head")


if __name__ == "__main__":
    upgrade()
    print("database is up to date")
