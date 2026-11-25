"""Синтетика для замеров: python -m app.synthetic SUBSCRIPTIONS EMPLOYEES

SUBSCRIPTIONS подписок «Сервис NNNN» в пяти валютах, EMPLOYEES сотрудников, у каждой подписки 5–50 мест,
занято около 70 %, у каждой третьей есть освобождённые назначения в истории, продления на год вперёд.
"""
from __future__ import annotations

import sys
from datetime import timedelta

from .db import connect, migrate, write_tx
from .service import iso, now, skey, today

CUR = ["RUB", "USD", "EUR", "CNY", "KZT"]


def main(argv: list[str]) -> int:
    n = int(argv[0]) if argv else 1000
    m = int(argv[1]) if len(argv) > 1 else 2000
    conn = connect()
    try:
        migrate(conn)
        t = now()
        with write_tx(conn):
            base = conn.execute("SELECT COUNT(*) FROM employees").fetchone()[0]
            emp = [conn.execute("INSERT INTO employees (name, department, search_key) VALUES (?, ?, ?) RETURNING id", (f"Сотрудник {base + i:05d}", "Синтетика", skey(f"Сотрудник {base + i:05d}"))).fetchone()["id"] for i in range(m)]
            subs = assigns = 0
            for i in range(n):
                name = f"Сервис {i:04d}"
                row = conn.execute("SELECT id FROM services WHERE search_key = ?", (skey(name),)).fetchone()
                sid = row["id"] if row else conn.execute("INSERT INTO services (name, search_key, created_at) VALUES (?, ?, ?) RETURNING id", (name, skey(name), iso(t))).fetchone()["id"]
                seats = 5 + i % 46
                d = today() + timedelta(days=i % 365)
                sub = conn.execute(
                    "INSERT INTO subscriptions (service_id, plan, seats, period, price_minor, currency, renews_on, anchor_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                    (sid, f"Тариф {i % 3 + 1}", seats, ("month", "quarter", "year")[i % 3], 1000 + i * 37, CUR[i % 5], d.isoformat(), d.day, iso(t)),
                ).fetchone()["id"]
                subs += 1
                for k in range(seats * 7 // 10):
                    conn.execute("INSERT INTO assignments (subscription_id, employee_id, assigned_at) VALUES (?, ?, ?)", (sub, emp[(i * 31 + k) % m], iso(t)))
                    assigns += 1
                if i % 3 == 0:
                    conn.execute("INSERT INTO assignments (subscription_id, employee_id, assigned_at, released_at) VALUES (?, ?, ?, ?)", (sub, emp[(i * 31 + seats) % m], iso(t - timedelta(days=60)), iso(t - timedelta(days=10))))
        print(f"subscriptions+={subs}, employees+={m}, assignments+={assigns}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
