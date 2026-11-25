"""Перезапуск на той же базе, миграции, ограничения базы (триггер лимита, одно активное назначение)."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import httpx
import pytest

from app.db import connect, latest_migration, migrate, schema_version
from app.seed import seed

from .conftest import free_port, http_login, start_server


def test_restart_keeps_assignments_and_history(tmp_path: Path) -> None:
    db = tmp_path / "keep.sqlite3"
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_server(db, port)
    try:
        h = http_login(base, "ops")
        sub = next(s for s in httpx.get(f"{base}/api/subscriptions", headers=h).json()["subscriptions"] if s["service"] == "Эфир")
        a = httpx.get(f"{base}/api/subscriptions/{sub['id']}", headers=h).json()["subscription"]["assignments"][0]
        assert httpx.post(f"{base}/api/assignments/{a['id']}/release", headers=h).json()["changed"] is True
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    proc = start_server(db, port)
    try:
        h = http_login(base, "ops")
        card = httpx.get(f"{base}/api/subscriptions/{sub['id']}", headers=h).json()["subscription"]
        assert card["free"] == 1 and card["history"][0]["employee"] == a["employee"]
        assert httpx.get(f"{base}/api/health").json()["schema_version"] == latest_migration()
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_migrate_idempotent(tmp_path: Path) -> None:
    conn = connect(str(tmp_path / "m.sqlite3"))
    try:
        assert migrate(conn) == latest_migration()
        assert migrate(conn) == latest_migration() == schema_version(conn)
    finally:
        conn.close()


def test_database_constraints(tmp_path: Path) -> None:
    conn = connect(str(tmp_path / "c.sqlite3"))
    try:
        seed(conn)
        sub = conn.execute("SELECT s.id FROM subscriptions s JOIN services v ON v.id = s.service_id WHERE v.name = 'Эфир'").fetchone()["id"]  # 3 из 3
        emp = conn.execute("SELECT id FROM employees WHERE name = 'Анна Белова'").fetchone()["id"]
        with pytest.raises(sqlite3.IntegrityError, match="seats_exhausted"):
            conn.execute("INSERT INTO assignments (subscription_id, employee_id, assigned_at) VALUES (?, ?, 'x')", (sub, emp))
        mk = conn.execute("SELECT s.id FROM subscriptions s JOIN services v ON v.id = s.service_id WHERE v.name = 'Макетница'").fetchone()["id"]
        with pytest.raises(sqlite3.IntegrityError):  # Анна уже занимает место
            conn.execute("INSERT INTO assignments (subscription_id, employee_id, assigned_at) VALUES (?, ?, 'x')", (mk, emp))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE subscriptions SET seats = 0 WHERE id = ?", (mk,))
    finally:
        conn.close()


def test_reset_restores_demo(tmp_path: Path) -> None:
    conn = connect(str(tmp_path / "r.sqlite3"))
    try:
        seed(conn)
        conn.execute("UPDATE assignments SET released_at = 'x'")
        assert seed(conn, reset=True) == {"users": 2, "employees": 8, "subscriptions": 4, "assignments": 15}
        assert conn.execute("SELECT COUNT(*) FROM assignments WHERE released_at IS NULL").fetchone()[0] == 14
    finally:
        conn.close()
