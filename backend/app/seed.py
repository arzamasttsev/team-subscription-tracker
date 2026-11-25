"""Демоданные: операционный менеджер, администратор, 8 сотрудников, 4 подписки в RUB, USD и EUR.

python -m app.seed           — создать, если нет (повторный запуск не дублирует данные)
python -m app.seed --reset   — вернуть демо (даты продления заново от сегодняшнего дня)

Демо из ТЗ: у «Макетницы» 5 мест и 4 назначения — последнее место занять можно, шестого нельзя.
Её продление через 7 дней видно в платежах. Сводка за 30 дней — в двух валютах (RUB и USD),
EUR-подписка продлевается позже и в итог не входит.
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import timedelta

from .auth import hash_password
from .db import connect, migrate, write_tx
from .service import iso, now, skey, today

RESET_ROLE = "admin"
DEMO_USERS: list[tuple[str, str, str, str]] = [
    ("ops", "Ольга Миронова", "ops", "ops-demo"),
    ("admin", "Пётр Захаров", "admin", "admin-demo"),
]
EMPLOYEES = [
    ("Анна Белова", "Дизайн"),
    ("Борис Ким", "Дизайн"),
    ("Вера Лис", "Продукт"),
    ("Глеб Орлов", "Разработка"),
    ("Дина Петрова", "Разработка"),
    ("Егор Савин", "Продажи"),
    ("Жанна Ткач", "Маркетинг"),
    ("Зоя Усова", "Поддержка"),
]
# сервис, тариф, мест, период, сумма (минимальные единицы), валюта, продление через N дней, назначенные (номера сотрудников)
SUBS = [
    ("Макетница", "Команда", 5, "month", 120_000, "USD", 7, [0, 1, 2, 6]),
    ("Поток", "Бизнес", 10, "year", 4_500_000, "RUB", 20, [0, 2, 3, 4, 5, 7]),
    ("Эфир", "Стандарт", 3, "month", 149_000, "RUB", 3, [5, 6, 7]),
    ("Склад", "Про", 2, "month", 999, "EUR", 45, [3]),
]


def seed(conn: sqlite3.Connection, reset: bool = False) -> dict[str, int]:
    migrate(conn)
    with write_tx(conn):
        if reset:
            for t in ("events", "assignments", "subscriptions", "services", "employees"):
                conn.execute(f"DELETE FROM {t}")
            demo = [u[0] for u in DEMO_USERS]
            conn.execute(f"DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users WHERE username IN ({','.join('?' * len(demo))}))", demo)
        uid: dict[str, int] = {}
        for username, name, role, pwd in DEMO_USERS:
            row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if row is None:
                h, salt = hash_password(pwd)
                row = conn.execute("INSERT INTO users (username, display_name, role, password_hash, salt) VALUES (?, ?, ?, ?, ?) RETURNING id", (username, name, role, h, salt)).fetchone()
            uid[username] = int(row["id"])
        if conn.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0] == 0:
            emp = [conn.execute("INSERT INTO employees (name, department, search_key) VALUES (?, ?, ?) RETURNING id", (n, d, skey(n))).fetchone()["id"] for n, d in EMPLOYEES]
            t = now()
            for svc, plan, seats, period, price, cur, days, who in SUBS:
                sid = conn.execute("INSERT INTO services (name, search_key, created_at) VALUES (?, ?, ?) RETURNING id", (svc, skey(svc), iso(t - timedelta(days=200)))).fetchone()["id"]
                d = today() + timedelta(days=days)
                sub = conn.execute(
                    "INSERT INTO subscriptions (service_id, plan, seats, period, price_minor, currency, renews_on, anchor_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                    (sid, plan, seats, period, price, cur, d.isoformat(), d.day, iso(t - timedelta(days=200))),
                ).fetchone()["id"]
                for k, e in enumerate(who):
                    conn.execute("INSERT INTO assignments (subscription_id, employee_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)", (sub, emp[e], iso(t - timedelta(days=100 - k)), uid["ops"]))
            # в истории «Макетницы» — освобождённое место Глеба Орлова
            mk = conn.execute("SELECT s.id FROM subscriptions s JOIN services v ON v.id = s.service_id WHERE v.name = 'Макетница'").fetchone()["id"]
            conn.execute(
                "INSERT INTO assignments (subscription_id, employee_id, assigned_at, assigned_by, released_at, released_by) VALUES (?, ?, ?, ?, ?, ?)",
                (mk, emp[3], iso(t - timedelta(days=150)), uid["ops"], iso(t - timedelta(days=40)), uid["ops"]),
            )
    return {k: conn.execute(f"SELECT COUNT(*) FROM {k}").fetchone()[0] for k in ("users", "employees", "subscriptions", "assignments")}


def main(argv: list[str]) -> int:
    conn = connect()
    try:
        c = seed(conn, reset="--reset" in argv)
        print(", ".join(f"{k}={v}" for k, v in c.items()))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
