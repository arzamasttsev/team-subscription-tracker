"""API учёта подписок: роли, приёмка ТЗ, повторное назначение, освобождение, продления в двух валютах."""
from __future__ import annotations

from datetime import date, timedelta

import httpx
import pytest

from app import service

from .conftest import login


def _subs(c: httpx.Client, h: dict[str, str]) -> dict[str, dict]:
    return {s["service"]: s for s in c.get("/api/subscriptions", headers=h).json()["subscriptions"]}


def _emp(c: httpx.Client, h: dict[str, str]) -> dict[str, int]:
    return {e["name"]: e["id"] for e in c.get("/api/employees", headers=h).json()["employees"]}


def test_money_and_months() -> None:
    assert service.parse_money("1 290,50") == 129050
    assert service.parse_money("1290.5") == 129050
    assert service.parse_money("45000") == 4500000
    assert service.parse_money(0) == 0
    for bad in ("12,345", "-5", "1e3", "", "сто"):
        with pytest.raises(service.BadRequest):
            service.parse_money(bad)
    # 31 января → 28 февраля → 31 марта: день привязки не теряется
    d = date(2027, 1, 31)
    d = service.add_months(d, 1, 31)
    assert d == date(2027, 2, 28)
    assert service.add_months(d, 1, 31) == date(2027, 3, 31)
    assert service.add_months(date(2027, 11, 30), 3, 30) == date(2028, 2, 29)  # високосный
    assert service.add_months(date(2027, 12, 15), 12, 15) == date(2028, 12, 15)


def test_roles(client: httpx.Client) -> None:
    assert client.get("/api/subscriptions").status_code == 401
    h = login(client, "ops")
    sub = _subs(client, h)["Макетница"]
    assert client.post(f"/api/subscriptions/{sub['id']}/assignments", json={"employee_id": 999}, headers=h).json()["code"] == "bad_employee"
    assert client.post("/api/demo/reset", headers=h).status_code == 403
    assert client.post("/api/demo/reset", headers=login(client, "admin")).status_code == 200


def test_acceptance_last_seat_then_limit(client: httpx.Client) -> None:
    """Приёмка ТЗ: 5 мест и 4 назначения — последнее место занять можно, шестого нельзя."""
    h = login(client, "ops")
    sub = _subs(client, h)["Макетница"]
    assert (sub["seats"], sub["used"], sub["free"]) == (5, 4, 1)
    e = _emp(client, h)
    r = client.post(f"/api/subscriptions/{sub['id']}/assignments", json={"employee_id": e["Дина Петрова"]}, headers=h)
    assert r.status_code == 201 and r.json()["changed"] is True
    card = r.json()["subscription"]
    assert (card["used"], card["free"]) == (5, 0)
    assert "Дина Петрова" in [a["employee"] for a in card["assignments"]]
    r = client.post(f"/api/subscriptions/{sub['id']}/assignments", json={"employee_id": e["Егор Савин"]}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "seats_exhausted"
    assert r.json()["message"] == "Свободных мест нет: занято 5 из 5"
    assert r.json()["subscription"]["used"] == 5  # актуальное состояние для интерфейса
    # Продление через 7 дней видно в платежах
    ren = client.get("/api/renewals", params={"within_days": 7}, headers=h).json()
    assert [(x["service"], x["days_left"]) for x in ren["upcoming"]] == [("Эфир", 3), ("Макетница", 7)]
    assert client.get("/api/renewals", params={"within_days": 6}, headers=h).json()["upcoming"][-1]["service"] == "Эфир"


def test_repeat_assignment_same_employee(client: httpx.Client) -> None:
    h = login(client, "ops")
    sub = _subs(client, h)["Поток"]
    anna = _emp(client, h)["Анна Белова"]
    r = client.post(f"/api/subscriptions/{sub['id']}/assignments", json={"employee_id": anna}, headers=h)
    assert r.status_code == 200 and r.json()["changed"] is False
    assert r.json()["subscription"]["used"] == sub["used"]
    # даже при полной подписке повтор того же сотрудника — не ошибка лимита
    full = _subs(client, h)["Эфир"]
    zoya = _emp(client, h)["Зоя Усова"]
    assert client.post(f"/api/subscriptions/{full['id']}/assignments", json={"employee_id": zoya}, headers=h).status_code == 200


def test_release_frees_seat_and_keeps_history(client: httpx.Client) -> None:
    h = login(client, "ops")
    sub = _subs(client, h)["Эфир"]
    card = client.get(f"/api/subscriptions/{sub['id']}", headers=h).json()["subscription"]
    a = card["assignments"][0]
    r1 = client.post(f"/api/assignments/{a['id']}/release", headers=h).json()
    r2 = client.post(f"/api/assignments/{a['id']}/release", headers=h).json()
    assert r1["changed"] is True and r2["changed"] is False
    assert (r2["subscription"]["used"], r2["subscription"]["free"]) == (2, 1)
    hist = r2["subscription"]["history"]
    assert hist[0]["employee"] == a["employee"] and hist[0]["released_by"] == "Ольга Миронова"
    # освободившееся место можно занять, тот же сотрудник может вернуться
    again = client.post(f"/api/subscriptions/{sub['id']}/assignments", json={"employee_id": a["employee_id"]}, headers=h)
    assert again.status_code == 201
    kinds = [e["kind"] for e in again.json()["subscription"]["events"]]
    assert kinds[:2] == ["assign", "release"]


def test_renewals_two_currencies_and_overdue(client: httpx.Client, monkeypatch: pytest.MonkeyPatch) -> None:
    h = login(client, "ops")
    ren = client.get("/api/renewals", headers=h).json()
    assert ren["totals"] == [{"currency": "RUB", "amount_minor": 4_649_000, "count": 2}, {"currency": "USD", "amount_minor": 120_000, "count": 1}]
    assert "EUR" not in [t["currency"] for t in ren["totals"]]  # «Склад» продлевается через 45 дней
    assert client.get("/api/renewals", params={"within_days": 60}, headers=h).json()["totals"][0] == {"currency": "EUR", "amount_minor": 999, "count": 1}
    # окно 90 дней: ежемесячные платятся по три раза, «Склад» дважды, годовой «Поток» один раз
    ren = client.get("/api/renewals", params={"within_days": 90}, headers=h).json()
    assert ren["totals"] == [
        {"currency": "EUR", "amount_minor": 2 * 999, "count": 2},
        {"currency": "RUB", "amount_minor": 3 * 149_000 + 4_500_000, "count": 4},
        {"currency": "USD", "amount_minor": 3 * 120_000, "count": 3},
    ]
    mk = [x for x in ren["upcoming"] if x["service"] == "Макетница"]
    assert [x["projected"] for x in mk] == [False, True, True]
    assert mk[0]["due_on"] == mk[0]["renews_on"] and mk[1]["due_on"] > mk[0]["due_on"]
    assert [x["due_on"] for x in ren["upcoming"]] == sorted(x["due_on"] for x in ren["upcoming"])
    # через 10 дней «Эфир» (3 дня) и «Макетница» (7) просрочены: сама дата в итог не входит, её надо отметить,
    # а следующий платёж через месяц от неё попадает в окно
    later = service.now() + timedelta(days=10)
    monkeypatch.setattr(service, "now", lambda: later)
    ren = client.get("/api/renewals", headers=h).json()
    assert [x["service"] for x in ren["overdue"]] == ["Эфир", "Макетница"]
    assert ren["totals"] == [{"currency": "RUB", "amount_minor": 4_500_000 + 149_000, "count": 2}, {"currency": "USD", "amount_minor": 120_000, "count": 1}]
    assert all(x["projected"] for x in ren["upcoming"] if x["service"] in ("Эфир", "Макетница"))


def test_mark_renewed_moves_date_by_period(client: httpx.Client) -> None:
    h = login(client, "ops")
    sub = _subs(client, h)["Макетница"]
    r = client.post(f"/api/subscriptions/{sub['id']}/renewed", json={"version": sub["version"]}, headers=h)
    new = r.json()["subscription"]
    assert new["renews_on"] == service.add_months(date.fromisoformat(sub["renews_on"]), 1, date.fromisoformat(sub["renews_on"]).day).isoformat()
    assert client.post(f"/api/subscriptions/{sub['id']}/renewed", json={"version": sub["version"]}, headers=h).json()["code"] == "version_conflict"


def test_edit_rules(client: httpx.Client) -> None:
    h = login(client, "ops")
    sub = _subs(client, h)["Поток"]  # 6 из 10
    r = client.patch(f"/api/subscriptions/{sub['id']}", json={"version": sub["version"], "seats": 5}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "seats_below_used"
    r = client.patch(f"/api/subscriptions/{sub['id']}", json={"version": sub["version"], "seats": 6, "price": "50 000,00", "renews_on": "2027-01-31"}, headers=h)
    s = r.json()["subscription"]
    assert (s["seats"], s["free"], s["price_minor"], s["renews_on"]) == (6, 0, 5_000_000, "2027-01-31")
    assert client.patch(f"/api/subscriptions/{sub['id']}", json={"version": sub["version"], "seats": 7}, headers=h).json()["code"] == "version_conflict"
    assert client.patch(f"/api/subscriptions/{sub['id']}", json={"version": s["version"], "status": "cancelled"}, headers=h).json()["code"] == "has_assignments"
    assert client.patch(f"/api/subscriptions/{sub['id']}", json={"version": s["version"], "price": "1,234"}, headers=h).json()["field"] == "price"
    assert client.patch(f"/api/subscriptions/{sub['id']}", json={"version": s["version"], "currency": "GBP"}, headers=h).json()["code"] == "bad_currency"


def test_create_subscription_and_employee(client: httpx.Client) -> None:
    h = login(client, "ops")
    r = client.post("/api/subscriptions", json={"service": "  макетница ", "plan": "Про", "seats": 2, "period": "year", "price": "9 990", "currency": "RUB", "renews_on": "2027-03-01"}, headers=h)
    assert r.status_code == 201
    s = r.json()["subscription"]
    assert (s["service"], s["plan"], s["free"], s["price_minor"]) == ("Макетница", "Про", 2, 999_000)  # сервис тот же, без дубля
    assert client.post("/api/subscriptions", json={"service": "X", "plan": "Y", "seats": 0, "period": "month", "price": 1, "currency": "RUB", "renews_on": "2027-03-01"}, headers=h).json()["field"] == "seats"
    assert client.post("/api/subscriptions", json={"service": "X", "plan": "Y", "seats": 1, "period": "month", "price": 1, "currency": "RUB", "renews_on": "01.03.2027"}, headers=h).json()["field"] == "renews_on"
    e = client.post("/api/employees", json={"name": " Ирина  Шульц ", "department": "Финансы"}, headers=h)
    assert e.status_code == 201 and e.json()["employee"]["name"] == "Ирина Шульц"
    assert client.post("/api/employees", json={"name": "ирина шульц"}, headers=h).json()["code"] == "name_taken"


def test_summary_and_csv(client: httpx.Client) -> None:
    h = login(client, "ops")
    s = client.get("/api/summary", headers=h).json()
    assert (s["seats"], s["used"], s["free"], s["subscriptions"]) == (20, 14, 6, 4)
    assert [x["service"] for x in s["full"]] == ["Эфир"]
    r = client.get("/api/subscriptions.csv", headers=h)
    assert r.headers["content-disposition"].startswith('attachment; filename="podpiski-')
    lines = r.text.split("\r\n")
    assert lines[0] == "﻿Сервис;Тариф;Статус;Мест;Занято;Свободно;Сумма за период;Валюта;Период;Дата продления;Сотрудники"
    assert any(l.startswith("Макетница;Команда;активна;5;4;1;1 200,00;USD;месяц;") and l.endswith("Анна Белова, Борис Ким, Вера Лис, Жанна Ткач") for l in lines)
