"""HTTP API учёта подписок команды и раздача собранного интерфейса."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import FastAPI, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import service, web
from .db import connect, migrate
from .web import Conn, CurrentUser, require_role

OPS = ("ops", "admin")


@asynccontextmanager
async def lifespan(_: FastAPI):
    conn = connect()
    try:
        migrate(conn)
        if web.env_flag("SEED_DEMO"):
            from .seed import seed

            seed(conn)
    finally:
        conn.close()
    yield


app = FastAPI(title="Учёт подписок команды", version="1.0.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
web.install(app)


class SubIn(BaseModel):
    service: str = Field(max_length=120)
    plan: str = Field(max_length=120)
    seats: int
    period: Literal["month", "quarter", "year"]
    price: str | int
    currency: str
    renews_on: str


class SubPatch(BaseModel):
    version: int = Field(ge=1)
    plan: str | None = Field(default=None, max_length=120)
    seats: int | None = None
    period: Literal["month", "quarter", "year"] | None = None
    price: str | int | None = None
    currency: str | None = None
    renews_on: str | None = None
    status: Literal["active", "cancelled"] | None = None


class VersionIn(BaseModel):
    version: int = Field(ge=1)


class AssignIn(BaseModel):
    employee_id: int


class EmployeeIn(BaseModel):
    name: str = Field(max_length=120)
    department: str = Field(default="", max_length=120)


@app.get("/api/subscriptions")
def subscriptions(conn: Conn, user: CurrentUser, q: str | None = None, status: Literal["active", "cancelled", "all"] = "active") -> dict[str, object]:
    return {"subscriptions": service.list_subscriptions(conn, q, status), "today": service.today().isoformat()}


@app.post("/api/subscriptions", status_code=201)
def create_subscription(body: SubIn, conn: Conn, user: CurrentUser) -> dict[str, object]:
    require_role(user, *OPS)
    sid = service.create_subscription(conn, user.id, body.service, body.plan, body.seats, body.period, body.price, body.currency, body.renews_on)
    return {"subscription": service.card(conn, sid)}


@app.get("/api/subscriptions/{sub_id}")
def get_subscription(sub_id: int, conn: Conn, user: CurrentUser) -> dict[str, object]:
    return {"subscription": service.card(conn, sub_id)}


@app.patch("/api/subscriptions/{sub_id}")
def patch_subscription(sub_id: int, body: SubPatch, conn: Conn, user: CurrentUser) -> dict[str, object]:
    require_role(user, *OPS)
    patch = body.model_dump(exclude_none=True, exclude={"version"})
    return {"subscription": service.edit_subscription(conn, user.id, sub_id, body.version, patch)}


@app.post("/api/subscriptions/{sub_id}/renewed")
def renewed(sub_id: int, body: VersionIn, conn: Conn, user: CurrentUser) -> dict[str, object]:
    require_role(user, *OPS)
    return {"subscription": service.mark_renewed(conn, user.id, sub_id, body.version)}


@app.post("/api/subscriptions/{sub_id}/assignments", status_code=201)
def assign(sub_id: int, body: AssignIn, conn: Conn, user: CurrentUser, response: Response) -> dict[str, object]:
    """201 — место назначено; 200 — этот сотрудник уже занимает место (повтор не дублирует назначение)."""
    require_role(user, *OPS)
    card, created = service.assign(conn, user.id, sub_id, body.employee_id)
    if not created:
        response.status_code = 200
    return {"subscription": card, "changed": created}


@app.post("/api/assignments/{assignment_id}/release")
def release(assignment_id: int, conn: Conn, user: CurrentUser) -> dict[str, object]:
    require_role(user, *OPS)
    card, changed = service.release(conn, user.id, assignment_id)
    return {"subscription": card, "changed": changed}


@app.get("/api/renewals")
def renewals(conn: Conn, user: CurrentUser, within_days: Annotated[int, Query(ge=0, le=366)] = 30) -> dict[str, object]:
    return service.renewals(conn, within_days)


@app.get("/api/summary")
def summary(conn: Conn, user: CurrentUser) -> dict[str, object]:
    return service.summary(conn)


@app.get("/api/employees")
def employees(conn: Conn, user: CurrentUser, q: str | None = None) -> dict[str, object]:
    return {"employees": service.list_employees(conn, q)}


@app.get("/api/employees/{emp_id}")
def employee(emp_id: int, conn: Conn, user: CurrentUser) -> dict[str, object]:
    return {"employee": service.employee_card(conn, emp_id)}


@app.post("/api/employees", status_code=201)
def create_employee(body: EmployeeIn, conn: Conn, user: CurrentUser) -> dict[str, object]:
    require_role(user, *OPS)
    eid = service.create_employee(conn, user.id, body.name, body.department)
    return {"employee": service.employee_card(conn, eid)}


@app.get("/api/subscriptions.csv")
def export_csv(conn: Conn, user: CurrentUser) -> Response:
    name = f"podpiski-{service.today().strftime('%Y%m%d')}.csv"
    return Response(service.subscriptions_csv(conn), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})


web.mount_static(app)
