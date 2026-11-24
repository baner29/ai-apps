"""Split-DB SQLite connection manager (local RW or candidate RO catalog + runtime DB)."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from backend.db.schema import CATALOG_SCHEMA_SQL, RUNTIME_SCHEMA_SQL


class DatabaseManager:
    """Manages catalog (questions/tags/templates) and runtime (submissions) SQLite connections."""

    def __init__(
        self,
        catalog_path: Path | str,
        runtime_path: Path | str,
        catalog_read_only: bool = False,
    ) -> None:
        self.catalog_path = Path(catalog_path)
        self.runtime_path = Path(runtime_path)
        self.catalog_read_only = catalog_read_only

    def _open_rw(self, path: Path) -> sqlite3.Connection:
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        return conn

    def _open_ro(self, path: Path) -> sqlite3.Connection:
        uri = f"{path.resolve().as_uri()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000;")
        return conn

    @contextmanager
    def catalog_conn(self) -> Iterator[sqlite3.Connection]:
        """Yield a SQLite connection to the catalog DB (read-only in candidate mode)."""
        if self.catalog_read_only:
            conn = self._open_ro(self.catalog_path)
            try:
                yield conn
            finally:
                conn.close()
        else:
            conn = self._open_rw(self.catalog_path)
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    @contextmanager
    def runtime_conn(self) -> Iterator[sqlite3.Connection]:
        """Yield a writable SQLite connection to the runtime/submissions DB."""
        conn = self._open_rw(self.runtime_path)
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_schemas(self) -> None:
        """Initialize catalog schema (when writable) and runtime submissions schema."""
        if not self.catalog_read_only:
            with self.catalog_conn() as conn:
                conn.executescript(CATALOG_SCHEMA_SQL)
        with self.runtime_conn() as conn:
            conn.executescript(RUNTIME_SCHEMA_SQL)
