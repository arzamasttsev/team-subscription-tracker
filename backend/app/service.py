"""Правила учёта подписок: места, назначения, продления и суммы по валютам.

Свободные места = лимит − активные назначения. Назначение проверяет лимит и единственность активного
назначения сотрудника в той же транзакции BEGIN IMMEDIATE (вторая линия — триггер и частичный
уникальный индекс в базе). Суммы — целые минимальные единицы валюты, итоги не смешивают валюты.
Платежи считаются от введённой даты продления и суммы периода: каждая дата окна — отдельный платёж.
"""
from __future__ import annotations

import calendar
import csv
import io
import os
import re
import sqlite3
from datetime import UTC, date, datetime, timedelta, timezone

from .db import write_tx
from .errors import BadRequest, Conflict, NotFound

CURRENCIES = {"RUB": "₽", "USD": "$", "EUR": "€", "CNY": "¥", "KZT": "₸"}
PERIODS = {"month": 1, "quarter": 3, "year": 12}
PERIOD_TEXT = {"month": "месяц", "quarter": "квартал", "year": "год"}
KIND_TEXT = {
    "subscription_create": "подписка добавлена",
    "subscription_edit": "подписка изменена",
    "assign": "место назначено",
    "release": "место освобождено",
    "renewed": "продление оплачено",
    "employee_create": "сотрудник добавлен",
}


def now() -> datetime:
    """Текущее время. Тесты подменяют эту функцию."""
    return datetime.now(UTC).replace(microsecond=0)


def iso(d: datetime) -> str:
    return d.astimezone(UTC).isoformat(timespec="seconds")


def tz() -> timezone:
    try:
        return timezone(timedelta(hours=float(os.environ.get("TZ_OFFSET_HOURS", "3"))))
    except ValueError:
        return timezone(timedelta(hours=3))


def today() -> date:
    """Сегодня в часовом поясе команды: продления — календарные даты, не моменты времени."""
    return now().astimezone(tz()).date()


def skey(s: str) -> str:
    return " ".join(s.split()).casefold().replace("ё", "е")


def clean(s: str) -> str:
    return " ".join(s.split())


def parse_money(raw: str | int, field: str = "price") -> int:
    """«1 290,50», «1290.5», «45000» → минимальные единицы без плавающей точки. Не больше двух знаков."""
    if isinstance(raw, int) and not isinstance(raw, bool):
        if raw < 0:
            raise BadRequest("bad_money", "Сумма не может быть отрицательной", field=field)
        return raw
    s = re.sub(r"[\s  ]", "", str(raw))
    m = re.fullmatch(r"(\d{1,12})(?:[.,](\d{1,2}))?", s)
    if not m:
        raise BadRequest("bad_money", "Сумма — число, не больше двух знаков после запятой: 1 290,50", field=field)
    return int(m.group(1)) * 100 + int((m.group(2) or "0").ljust(2, "0"))


def parse_day(raw: str, field: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise BadRequest("bad_date", "Дата в формате ГГГГ-ММ-ДД", field=field) from exc


def add_months(d: date, months: int, anchor_day: int) -> date:
    """Следующая дата продления: тот же день месяца (anchor_day), а в коротком месяце — последний день."""
    y, m = divmod(d.month - 1 + months, 12)
    y += d.year
    m += 1
    return date(y, m, min(anchor_day, calendar.monthrange(y, m)[1]))


def event(conn: sqlite3.Connection, actor: int | None, kind: str, sub: int | None = None, emp: int | None = None, details: str = "") -> None:
    conn.execute("INSERT INTO events (at, actor_id, kind, subscription_id, employee_id, details) VALUES (?, ?, ?, ?, ?, ?)", (iso(now()), actor, kind, sub, emp, details))


# ---------- подписки ----------

SUB_SQL = """SELECT s.*, sv.name AS service,
  (SELECT COUNT(*) FROM assignments a WHERE a.subscription_id = s.id AND a.released_at IS NULL) AS used
FROM subscriptions s JOIN services sv ON sv.id = s.service_id"""


def _sub_json(r: sqlite3.Row) -> dict[str, object]:
    t = today()
    renews = date.fromisoformat(r["renews_on"])
    return {
        "id": r["id"],
        "service": r["service"],
        "service_id": r["service_id"],
        "plan": r["plan"],
        "seats": r["seats"],
        "used": r["used"],
        "free": max(0, r["seats"] - r["used"]),
        "period": r["period"],
        "price_minor": r["price_minor"],
        "currency": r["currency"],
        "renews_on": r["renews_on"],
        "days_left": (renews - t).days,
        "status": r["status"],
        "version": r["version"],
    }


def list_subscriptions(conn: sqlite3.Connection, q: str | None, status: str) -> list[dict[str, object]]:
    sql = SUB_SQL + " WHERE 1 = 1"
    args: list[object] = []
    if status != "all":
        sql += " AND s.status = ?"
        args.append(status)
    rows = [_sub_json(r) for r in conn.execute(sql + " ORDER BY sv.search_key, s.plan, s.id", args)]
    if q:
        k = skey(q)
        rows = [r for r in rows if k in skey(f"{r['service']} {r['plan']}")]
    return rows


def subscription(conn: sqlite3.Connection, sub_id: int) -> dict[str, object]:
    r = conn.execute(SUB_SQL + " WHERE s.id = ?", (sub_id,)).fetchone()
    if r is None:
        raise NotFound("not_found", "Подписка не найдена")
    return _sub_json(r)


def card(conn: sqlite3.Connection, sub_id: int) -> dict[str, object]:
    s = subscription(conn, sub_id)
    rows = conn.execute(
        """SELECT a.*, e.name AS employee, e.department, ua.display_name AS assigned_by_name, ur.display_name AS released_by_name
        FROM assignments a JOIN employees e ON e.id = a.employee_id LEFT JOIN users ua ON ua.id = a.assigned_by LEFT JOIN users ur ON ur.id = a.released_by
        WHERE a.subscription_id = ? ORDER BY a.released_at IS NOT NULL, a.released_at DESC, e.name""",
        (sub_id,),
    ).fetchall()
    s["assignments"] = [_assignment(r) for r in rows if r["released_at"] is None]
    s["history"] = [_assignment(r) for r in rows if r["released_at"] is not None]
    s["events"] = [
        {**dict(e), "kind_text": KIND_TEXT[e["kind"]]}
        for e in conn.execute(
            "SELECT ev.at, ev.kind, ev.details, u.display_name AS actor, em.name AS employee FROM events ev LEFT JOIN users u ON u.id = ev.actor_id LEFT JOIN employees em ON em.id = ev.employee_id WHERE ev.subscription_id = ? ORDER BY ev.id DESC LIMIT 100",
            (sub_id,),
        )
    ]
    return s


def _assignment(r: sqlite3.Row) -> dict[str, object]:
    return {
        "id": r["id"],
        "subscription_id": r["subscription_id"],
        "employee_id": r["employee_id"],
        "employee": r["employee"],
        "department": r["department"],
        "assigned_at": r["assigned_at"],
        "assigned_by": r["assigned_by_name"],
        "released_at": r["released_at"],
        "released_by": r["released_by_name"],
    }


def _service_id(conn: sqlite3.Connection, name: str) -> int:
    n = clean(name)
    if not n:
        raise BadRequest("required", "Укажите сервис", field="service")
    r = conn.execute("SELECT id FROM services WHERE search_key = ?", (skey(n),)).fetchone()
    if r:
        return int(r["id"])
    return int(conn.execute("INSERT INTO services (name, search_key, created_at) VALUES (?, ?, ?) RETURNING id", (n, skey(n), iso(now()))).fetchone()["id"])


def _check_fields(plan: str, seats: int, period: str, currency: str) -> None:
    if not clean(plan):
        raise BadRequest("required", "Укажите тариф", field="plan")
    if seats < 1 or seats > 100_000:
        raise BadRequest("bad_seats", "Мест — от 1 до 100 000", field="seats")
    if period not in PERIODS:
        raise BadRequest("bad_period", "Период — месяц, квартал или год", field="period")
    if currency not in CURRENCIES:
        raise BadRequest("bad_currency", "Валюта: " + ", ".join(CURRENCIES), field="currency")


def create_subscription(conn: sqlite3.Connection, actor: int, service: str, plan: str, seats: int, period: str, price: str | int, currency: str, renews_on: str) -> int:
    _check_fields(plan, seats, period, currency)
    price_minor = parse_money(price)
    d = parse_day(renews_on, "renews_on")
    with write_tx(conn):
        sid = _service_id(conn, service)
        sub = conn.execute(
            "INSERT INTO subscriptions (service_id, plan, seats, period, price_minor, currency, renews_on, anchor_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            (sid, clean(plan), seats, period, price_minor, currency, d.isoformat(), d.day, iso(now())),
        ).fetchone()["id"]
        event(conn, actor, "subscription_create", sub, details=f"{clean(plan)}, мест {seats}")
        return int(sub)


def edit_subscription(conn: sqlite3.Connection, actor: int, sub_id: int, version: int, patch: dict[str, object]) -> dict[str, object]:
    with write_tx(conn):
        cur = conn.execute("SELECT * FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()
        if cur is None:
            raise NotFound("not_found", "Подписка не найдена")
        if cur["version"] != version:
            raise Conflict("version_conflict", "Подписку уже изменили: данные обновлены", subscription=card(conn, sub_id))
        plan = clean(str(patch.get("plan", cur["plan"])))
        seats = int(patch.get("seats", cur["seats"]))  # type: ignore[arg-type]
        period = str(patch.get("period", cur["period"]))
        currency = str(patch.get("currency", cur["currency"]))
        _check_fields(plan, seats, period, currency)
        price_minor = parse_money(patch["price"]) if "price" in patch else cur["price_minor"]  # type: ignore[arg-type]
        d = parse_day(str(patch["renews_on"]), "renews_on") if "renews_on" in patch else date.fromisoformat(cur["renews_on"])
        anchor = d.day if "renews_on" in patch else cur["anchor_day"]
        status = str(patch.get("status", cur["status"]))
        if status not in ("active", "cancelled"):
            raise BadRequest("bad_status", "Неизвестный статус", field="status")
        used = conn.execute("SELECT COUNT(*) FROM assignments WHERE subscription_id = ? AND released_at IS NULL", (sub_id,)).fetchone()[0]
        if seats < used:
            raise Conflict("seats_below_used", f"Занято мест: {used}. Сначала освободите лишние места", field="seats", subscription=card(conn, sub_id))
        if status == "cancelled" and used:
            raise Conflict("has_assignments", f"Сначала освободите места: занято {used}", subscription=card(conn, sub_id))
        conn.execute(
            "UPDATE subscriptions SET plan = ?, seats = ?, period = ?, price_minor = ?, currency = ?, renews_on = ?, anchor_day = ?, status = ?, version = version + 1 WHERE id = ?",
            (plan, seats, period, price_minor, currency, d.isoformat(), anchor, status, sub_id),
        )
        changed = [k for k in ("plan", "seats", "period", "price", "currency", "renews_on", "status") if k in patch]
        event(conn, actor, "subscription_edit", sub_id, details=", ".join(changed))
        return card(conn, sub_id)


def mark_renewed(conn: sqlite3.Connection, actor: int, sub_id: int, version: int) -> dict[str, object]:
    """Платёж прошёл: дата продления сдвигается на период от прежней даты (не от сегодня)."""
    with write_tx(conn):
        cur = conn.execute("SELECT * FROM subscriptions WHERE id = ?", (sub_id,)).fetchone()
        if cur is None:
            raise NotFound("not_found", "Подписка не найдена")
        if cur["version"] != version:
            raise Conflict("version_conflict", "Подписку уже изменили: данные обновлены", subscription=card(conn, sub_id))
        if cur["status"] != "active":
            raise Conflict("cancelled", "Подписка отменена", subscription=card(conn, sub_id))
        old = date.fromisoformat(cur["renews_on"])
        new = add_months(old, PERIODS[cur["period"]], cur["anchor_day"])
        conn.execute("UPDATE subscriptions SET renews_on = ?, version = version + 1 WHERE id = ?", (new.isoformat(), sub_id))
        event(conn, actor, "renewed", sub_id, details=f"{old.isoformat()} → {new.isoformat()}")
        return card(conn, sub_id)


# ---------- назначения ----------

def assign(conn: sqlite3.Connection, actor: int, sub_id: int, employee_id: int) -> tuple[dict[str, object], bool]:
    """Назначить место. Повтор для того же сотрудника — существующее назначение (changed=False)."""
    with write_tx(conn):
        sub = conn.execute(SUB_SQL + " WHERE s.id = ?", (sub_id,)).fetchone()
        if sub is None:
            raise NotFound("not_found", "Подписка не найдена")
        emp = conn.execute("SELECT * FROM employees WHERE id = ?", (employee_id,)).fetchone()
        if emp is None or not emp["active"]:
            raise BadRequest("bad_employee", "Сотрудник не найден", field="employee_id")
        if sub["status"] != "active":
            raise Conflict("cancelled", "Подписка отменена: назначать места нельзя", subscription=card(conn, sub_id))
        same = conn.execute("SELECT id FROM assignments WHERE subscription_id = ? AND employee_id = ? AND released_at IS NULL", (sub_id, employee_id)).fetchone()
        if same:
            return card(conn, sub_id), False
        if sub["used"] >= sub["seats"]:
            raise Conflict("seats_exhausted", f"Свободных мест нет: занято {sub['used']} из {sub['seats']}", subscription=card(conn, sub_id))
        try:
            conn.execute("INSERT INTO assignments (subscription_id, employee_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)", (sub_id, employee_id, iso(now()), actor))
        except sqlite3.IntegrityError as exc:  # триггер или уникальный индекс
            raise Conflict("seats_exhausted", "Свободных мест нет", subscription=card(conn, sub_id)) from exc
        event(conn, actor, "assign", sub_id, employee_id)
        return card(conn, sub_id), True


def release(conn: sqlite3.Connection, actor: int, assignment_id: int) -> tuple[dict[str, object], bool]:
    """Архивировать назначение: место освобождается, запись остаётся в истории. Повтор — без изменений."""
    with write_tx(conn):
        a = conn.execute("SELECT * FROM assignments WHERE id = ?", (assignment_id,)).fetchone()
        if a is None:
            raise NotFound("not_found", "Назначение не найдено")
        if a["released_at"] is not None:
            return card(conn, a["subscription_id"]), False
        conn.execute("UPDATE assignments SET released_at = ?, released_by = ? WHERE id = ?", (iso(now()), actor, assignment_id))
        event(conn, actor, "release", a["subscription_id"], a["employee_id"])
        return card(conn, a["subscription_id"]), True


# ---------- продления и сводка ----------

def renewals(conn: sqlite3.Connection, within_days: int) -> dict[str, object]:
    """Платежи в окне [сегодня, сегодня + N] и просроченные даты (их нужно отметить).

    Ежемесячная подписка в окне 90 дней платится три раза: каждая дата окна — отдельная строка.
    Первая строка подписки — сохранённая дата продления (её отмечают «Оплачено»), следующие —
    прогноз от неё же через период (projected). Просроченная дата в итог не входит: это забытая
    отметка, а не будущий платёж, но её следующие даты внутри окна входят. Итоги — по валютам."""
    t = today()
    end = t + timedelta(days=within_days)
    rows = [_sub_json(r) for r in conn.execute(SUB_SQL + " WHERE s.status = 'active' AND s.renews_on <= ? ORDER BY s.renews_on, sv.search_key, s.id", (end.isoformat(),))]
    anchors = {r["id"]: r["anchor_day"] for r in conn.execute("SELECT id, anchor_day FROM subscriptions WHERE status = 'active'")}
    upcoming: list[dict[str, object]] = []
    overdue: list[dict[str, object]] = []
    for r in rows:
        d = date.fromisoformat(str(r["renews_on"]))
        if d < t:
            overdue.append({**r, "due_on": d.isoformat(), "projected": False})
        months = PERIODS[str(r["period"])]
        step = 0
        while d <= end:
            if d >= t:
                upcoming.append({**r, "due_on": d.isoformat(), "days_left": (d - t).days, "projected": step > 0})
            step += 1
            d = add_months(date.fromisoformat(str(r["renews_on"])), months * step, int(anchors[r["id"]]))
    upcoming.sort(key=lambda x: (str(x["due_on"]), str(x["service"]).casefold(), int(x["id"])))  # type: ignore[arg-type]
    totals: dict[str, list[int]] = {}
    for x in upcoming:
        acc = totals.setdefault(str(x["currency"]), [0, 0])
        acc[0] += int(x["price_minor"])  # type: ignore[arg-type]
        acc[1] += 1
    return {
        "today": t.isoformat(),
        "within_days": within_days,
        "upcoming": upcoming,
        "overdue": overdue,
        "totals": [{"currency": c, "amount_minor": v[0], "count": v[1]} for c, v in sorted(totals.items())],
    }


def summary(conn: sqlite3.Connection) -> dict[str, object]:
    subs = list_subscriptions(conn, None, "active")
    r = renewals(conn, 30)
    return {
        "seats": sum(int(s["seats"]) for s in subs),  # type: ignore[arg-type]
        "used": sum(int(s["used"]) for s in subs),  # type: ignore[arg-type]
        "free": sum(int(s["free"]) for s in subs),  # type: ignore[arg-type]
        "subscriptions": len(subs),
        "full": [s for s in subs if s["free"] == 0],
        "with_free": [s for s in subs if s["free"]],
        "renewals": r,
    }


# ---------- сотрудники ----------

def list_employees(conn: sqlite3.Connection, q: str | None) -> list[dict[str, object]]:
    rows = conn.execute(
        """SELECT e.id, e.name, e.department, e.search_key,
        (SELECT COUNT(*) FROM assignments a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.employee_id = e.id AND a.released_at IS NULL) AS seats
        FROM employees e WHERE e.active = 1 ORDER BY e.search_key""",
    ).fetchall()
    out = [dict(r) for r in rows]
    if q:
        k = skey(q)
        out = [r for r in out if k in r["search_key"]]
    for r in out:
        r.pop("search_key")
    return out


def employee_card(conn: sqlite3.Connection, emp_id: int) -> dict[str, object]:
    e = conn.execute("SELECT id, name, department FROM employees WHERE id = ?", (emp_id,)).fetchone()
    if e is None:
        raise NotFound("not_found", "Сотрудник не найден")
    rows = conn.execute(
        "SELECT a.id, a.subscription_id, a.assigned_at, sv.name AS service, s.plan FROM assignments a JOIN subscriptions s ON s.id = a.subscription_id JOIN services sv ON sv.id = s.service_id WHERE a.employee_id = ? AND a.released_at IS NULL ORDER BY sv.search_key",
        (emp_id,),
    )
    return {**dict(e), "assignments": [dict(r) for r in rows]}


def create_employee(conn: sqlite3.Connection, actor: int, name: str, department: str) -> int:
    n = clean(name)
    if not n:
        raise BadRequest("required", "Укажите имя", field="name")
    with write_tx(conn):
        if conn.execute("SELECT 1 FROM employees WHERE search_key = ? AND active = 1", (skey(n),)).fetchone():
            raise Conflict("name_taken", f"Сотрудник «{n}» уже есть", field="name")
        eid = conn.execute("INSERT INTO employees (name, department, search_key) VALUES (?, ?, ?) RETURNING id", (n, clean(department), skey(n))).fetchone()["id"]
        event(conn, actor, "employee_create", None, eid)
        return int(eid)


# ---------- экспорт ----------

def _cell(v: object) -> str:
    s = str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def money_text(minor: int, currency: str) -> str:
    whole, frac = divmod(minor, 100)
    return f"{whole:,}".replace(",", " ") + f",{frac:02d}"


def subscriptions_csv(conn: sqlite3.Connection) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(["Сервис", "Тариф", "Статус", "Мест", "Занято", "Свободно", "Сумма за период", "Валюта", "Период", "Дата продления", "Сотрудники"])
    for s in list_subscriptions(conn, None, "all"):
        names = [r["name"] for r in conn.execute("SELECT e.name FROM assignments a JOIN employees e ON e.id = a.employee_id WHERE a.subscription_id = ? AND a.released_at IS NULL ORDER BY e.search_key", (s["id"],))]
        w.writerow([_cell(x) for x in (s["service"], s["plan"], "активна" if s["status"] == "active" else "отменена", s["seats"], s["used"], s["free"], money_text(int(s["price_minor"]), str(s["currency"])), s["currency"], PERIOD_TEXT[str(s["period"])], s["renews_on"], ", ".join(names))])  # type: ignore[arg-type]
    return "﻿" + buf.getvalue()
