from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


def _db_path() -> Path:
    env_path = os.getenv("LAB3_DB_PATH")
    if env_path:
        return Path(env_path)
    return Path(__file__).with_name("app.db")


def init_db() -> None:
    db_path = _db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS plans (
              id TEXT PRIMARY KEY,
              title TEXT,
              date TEXT NOT NULL,
              budget INTEGER,
              people_count INTEGER,
              preferences TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS places (
              id TEXT PRIMARY KEY,
              plan_id TEXT NOT NULL,
              name TEXT NOT NULL,
              address TEXT,
              lng REAL NOT NULL,
              lat REAL NOT NULL,
              adcode TEXT,
              note TEXT,
              sort_index INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE
            );
            """
        )

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_places_plan_id ON places(plan_id);"
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS itinerary_items (
              id TEXT PRIMARY KEY,
              plan_id TEXT NOT NULL,
              place_id TEXT NOT NULL,
              time_slot TEXT NOT NULL,
              sort_index INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE,
              FOREIGN KEY(place_id) REFERENCES places(id) ON DELETE CASCADE
            );
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_itinerary_plan_id ON itinerary_items(plan_id);"
        )
        conn.commit()


@contextmanager
def get_conn():
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys=ON;")
        yield conn
    finally:
        conn.close()

