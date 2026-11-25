"""Конкурентные запросы на настоящем uvicorn: последнее место и повтор того же сотрудника."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import httpx

from .conftest import http_login


def _get(base: str, path: str, h: dict[str, str]) -> dict:
    return httpx.get(f"{base}{path}", headers=h, timeout=30).json()


def test_parallel_requests_for_last_seat(live_server: str) -> None:
    h = http_login(live_server, "ops")
    sub = next(s for s in _get(live_server, "/api/subscriptions", h)["subscriptions"] if s["service"] == "Макетница")
    taken = {a["employee_id"] for a in _get(live_server, f"/api/subscriptions/{sub['id']}", h)["subscription"]["assignments"]}
    free = [e["id"] for e in _get(live_server, "/api/employees", h)["employees"] if e["id"] not in taken]
    with ThreadPoolExecutor(max_workers=len(free)) as pool:
        res = list(pool.map(lambda e: httpx.post(f"{live_server}/api/subscriptions/{sub['id']}/assignments", json={"employee_id": e}, headers=h, timeout=30), free))
    codes = sorted(r.status_code for r in res)
    assert codes.count(201) == 1 and codes.count(409) == len(free) - 1
    card = _get(live_server, f"/api/subscriptions/{sub['id']}", h)["subscription"]
    assert (card["used"], card["free"]) == (5, 0)


def test_parallel_same_employee(live_server: str) -> None:
    h = http_login(live_server, "ops")
    sub = next(s for s in _get(live_server, "/api/subscriptions", h)["subscriptions"] if s["service"] == "Поток")
    zoya = next(e["id"] for e in _get(live_server, "/api/employees", h)["employees"] if e["name"] == "Жанна Ткач")
    with ThreadPoolExecutor(max_workers=8) as pool:
        res = list(pool.map(lambda _: httpx.post(f"{live_server}/api/subscriptions/{sub['id']}/assignments", json={"employee_id": zoya}, headers=h, timeout=30), range(8)))
    assert sorted(r.status_code for r in res) == [200] * 7 + [201]
    card = _get(live_server, f"/api/subscriptions/{sub['id']}", h)["subscription"]
    assert [a["employee"] for a in card["assignments"]].count("Жанна Ткач") == 1 and card["used"] == sub["used"] + 1
