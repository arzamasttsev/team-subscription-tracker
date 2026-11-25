#!/usr/bin/env python3
"""Сквозная проверка запущенного контейнера без сторонних библиотек.

    python3 scripts/container_check.py                 # http://127.0.0.1:8226
    python3 scripts/container_check.py --restart       # + docker compose restart и проверка сохранности
    python3 scripts/container_check.py --base http://127.0.0.1:9000

Шаги: готовность → входы → сброс демо → приёмка ТЗ (в «Макетнице» 5 мест и 4 назначения: пятое место
занимается, шестое — отказ «Свободных мест нет»; продление через 7 дней в платежах) → 8 одновременных
запросов на последнее место «Склада»: занято одно → повтор назначения того же сотрудника без второго
места → освобождение и история → итоги по двум валютам → права (403) → CSV →
[перезапуск → назначение, история и журнал сохранены].
Демо-режим (DEMO_MODE=1) обязателен: используется /api/demo/reset.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
from pathlib import Path

USERS = {"ops": "ops-demo", "admin": "admin-demo"}


class Session:
    def __init__(self, base: str) -> None:
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def raw(self, method: str, path: str) -> tuple[int, bytes, dict]:
        req = urllib.request.Request(self.base + path, method=method)
        try:
            with self.opener.open(req, timeout=15) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
        try:
            with self.opener.open(req, timeout=15) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")


def wait_ready(base: str, timeout: float = 90) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=2) as r:
                h = json.loads(r.read())
                if h.get("status") == "ok":
                    return h
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(1)
    raise SystemExit("FAIL: сервер не стал готов")


def step(ok: bool, text: str) -> None:
    print(("ok   " if ok else "FAIL ") + text)
    if not ok:
        sys.exit(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8226")
    ap.add_argument("--restart", action="store_true")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    h = wait_ready(base)
    step(True, f"готовность: схема v{h.get('schema_version')}")
    s = {u: Session(base) for u in USERS}
    for u, sess in s.items():
        st, _ = sess.call("POST", "/api/auth/login", {"username": u, "password": USERS[u]})
        step(st == 200, f"вход {u}")
    st, _ = s["admin"].call("POST", "/api/demo/reset")
    step(st == 200, "сброс демо")
    ops = s["ops"]
    subs = {x["service"]: x for x in ops.call("GET", "/api/subscriptions")[1]["subscriptions"]}
    emps = {e["name"]: e["id"] for e in ops.call("GET", "/api/employees")[1]["employees"]}
    mk = subs["Макетница"]
    step(mk["seats"] == 5 and mk["used"] == 4 and mk["free"] == 1, "приёмка: «Макетница» — 5 мест, 4 назначения")
    st, r = ops.call("POST", f"/api/subscriptions/{mk['id']}/assignments", {"employee_id": emps["Дина Петрова"]})
    step(st == 201 and r["subscription"]["free"] == 0, "приёмка: пятое место занято (201)")
    st, r = ops.call("POST", f"/api/subscriptions/{mk['id']}/assignments", {"employee_id": emps["Егор Савин"]})
    step(st == 409 and r["code"] == "seats_exhausted" and r["message"] == "Свободных мест нет: занято 5 из 5", f"приёмка: шестое — 409 «{r.get('message')}»")
    ren = ops.call("GET", "/api/renewals?within_days=7")[1]
    row = next((x for x in ren["upcoming"] if x["service"] == "Макетница"), None)
    step(row is not None and row["days_left"] == 7, "приёмка: продление через 7 дней в платежах")

    sk = subs["Склад"]  # 2 места, занято 1
    free = [emps[n] for n in ("Анна Белова", "Борис Ким", "Вера Лис", "Дина Петрова", "Егор Савин", "Жанна Ткач", "Зоя Усова")]  # Глеб уже в «Складе»
    pool_sessions = [Session(base) for _ in free]
    for p in pool_sessions:
        p.call("POST", "/api/auth/login", {"username": "ops", "password": USERS["ops"]})
    with ThreadPoolExecutor(max_workers=len(free)) as pool:
        out = list(pool.map(lambda i: pool_sessions[i].call("POST", f"/api/subscriptions/{sk['id']}/assignments", {"employee_id": free[i]}), range(len(free))))
    codes = sorted(x[0] for x in out)
    card = ops.call("GET", f"/api/subscriptions/{sk['id']}")[1]["subscription"]
    step(codes.count(201) == 1 and set(codes) <= {201, 409} and card["used"] == 2, f"{len(free)} одновременных запросов на последнее место: коды {codes}, занято {card['used']} из {card['seats']}")
    winner = next(free[i] for i, x in enumerate(out) if x[0] == 201)
    st, r = ops.call("POST", f"/api/subscriptions/{sk['id']}/assignments", {"employee_id": winner})
    step(st == 200 and not r["changed"] and r["subscription"]["used"] == 2, "повтор назначения того же сотрудника: 200 без второго места")

    ef = subs["Эфир"]
    a = next(x for x in ops.call("GET", f"/api/subscriptions/{ef['id']}")[1]["subscription"]["assignments"] if x["employee"] == "Егор Савин")
    st, r = ops.call("POST", f"/api/assignments/{a['id']}/release")
    st2, r2 = ops.call("POST", f"/api/assignments/{a['id']}/release")
    step(st == 200 and r["changed"] and r["subscription"]["free"] == 1 and any(x["id"] == a["id"] for x in r["subscription"]["history"]) and not r2["changed"], "освобождение: место свободно, запись в истории, повтор без изменений")

    tot = {t["currency"]: t for t in ops.call("GET", "/api/renewals?within_days=30")[1]["totals"]}
    step(tot["RUB"]["amount_minor"] == 4_649_000 and tot["USD"]["amount_minor"] == 120_000 and "EUR" not in tot, "итоги за 30 дней раздельно: RUB 46 490,00 и USD 1 200,00")
    tot90 = {t["currency"]: t for t in ops.call("GET", "/api/renewals?within_days=90")[1]["totals"]}
    step(tot90["USD"]["count"] == 3 and tot90["USD"]["amount_minor"] == 360_000, "окно 90 дней: месячная подписка — три платежа")

    st, r = Session(base).call("GET", "/api/subscriptions")
    step(st == 401, "без входа — 401")
    st, body, hdr = ops.raw("GET", "/api/subscriptions.csv")
    text = body.decode("utf-8-sig")
    step(st == 200 and text.startswith("Сервис;Тариф;Статус;Мест;Занято;Свободно") and "Макетница;Команда;активна;5;5;0;" in text, "CSV: заголовок и занятость")
    st, _ = ops.call("POST", "/api/demo/reset")
    step(st == 403, "сброс демо только администратору (403 для ops)")

    if args.restart:
        root = Path(__file__).resolve().parent.parent
        subprocess.run(["docker", "compose", "restart", "app"], cwd=root, check=True)
        wait_ready(base)
        a2 = Session(base)
        a2.call("POST", "/api/auth/login", {"username": "ops", "password": USERS["ops"]})
        c = a2.call("GET", f"/api/subscriptions/{mk['id']}")[1]["subscription"]
        e = a2.call("GET", f"/api/subscriptions/{ef['id']}")[1]["subscription"]
        step(c["used"] == 5 and any(x["employee"] == "Дина Петрова" for x in c["assignments"]) and any(x["employee"] == "Егор Савин" for x in e["history"]), "после перезапуска назначения, история и журнал сохранены")
    print("Все проверки пройдены")
    return 0


if __name__ == "__main__":
    sys.exit(main())
