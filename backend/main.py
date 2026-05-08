from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from db import get_conn, init_db
from checks import build_checks
from exporter import build_plan_export_json, build_plan_export_md
from llm import LlmConfigMissing, LlmUpstreamError, chat_complete
from schemas import (
    AiSummaryRequest,
    AiSummaryResponse,
    ItineraryItemOut,
    ItineraryUpdate,
    PlaceCreate,
    PlaceOut,
    PlanCreate,
    PlanOut,
    PlanUpdate,
)
from weather import WeatherKeyMissing, WeatherUpstreamError, get_live_weather_by_adcode

app = FastAPI(title="Lab 3-2 Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True}


@app.on_event("startup")
def _startup():
    # Load local secrets from backend/.env (do not commit)
    load_dotenv()
    init_db()


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


@app.post("/api/plans", response_model=PlanOut)
def create_plan(payload: PlanCreate):
    plan_id = str(uuid4())
    now = _now_iso()

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO plans (id, title, date, budget, people_count, preferences, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plan_id,
                payload.title,
                payload.date,
                payload.budget,
                payload.people_count,
                payload.preferences,
                now,
                now,
            ),
        )
        conn.commit()

        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()

    return PlanOut.model_validate(dict(row))


@app.get("/api/plans", response_model=list[PlanOut])
def list_plans():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM plans ORDER BY datetime(updated_at) DESC"
        ).fetchall()
    return [PlanOut.model_validate(dict(r)) for r in rows]


@app.get("/api/plans/{plan_id}", response_model=PlanOut)
def get_plan(plan_id: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Plan not found")
    return PlanOut.model_validate(dict(row))


@app.put("/api/plans/{plan_id}", response_model=PlanOut)
def update_plan(plan_id: str, payload: PlanUpdate):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Plan not found")

        current = dict(row)
        new_data = payload.model_dump(exclude_unset=True)
        merged = {**current, **new_data}
        merged["updated_at"] = _now_iso()

        conn.execute(
            """
            UPDATE plans
               SET title = ?,
                   date = ?,
                   budget = ?,
                   people_count = ?,
                   preferences = ?,
                   updated_at = ?
             WHERE id = ?
            """,
            (
                merged.get("title"),
                merged.get("date"),
                merged.get("budget"),
                merged.get("people_count"),
                merged.get("preferences"),
                merged.get("updated_at"),
                plan_id,
            ),
        )
        conn.commit()

        updated = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()

    return PlanOut.model_validate(dict(updated))


@app.post("/api/plans/{plan_id}/places", response_model=PlaceOut)
def add_place(plan_id: str, payload: PlaceCreate):
    now = _now_iso()
    place_id = str(uuid4())

    with get_conn() as conn:
        plan = conn.execute("SELECT id FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found")

        conn.execute(
            """
            INSERT INTO places (id, plan_id, name, address, lng, lat, adcode, note, sort_index, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                place_id,
                plan_id,
                payload.name,
                payload.address,
                payload.lng,
                payload.lat,
                payload.adcode,
                payload.note,
                payload.sort_index or 0,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM places WHERE id = ?", (place_id,)).fetchone()

    return PlaceOut.model_validate(dict(row))


@app.get("/api/plans/{plan_id}/places", response_model=list[PlaceOut])
def list_places(plan_id: str):
    with get_conn() as conn:
        plan = conn.execute("SELECT id FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found")

        rows = conn.execute(
            """
            SELECT * FROM places
             WHERE plan_id = ?
             ORDER BY sort_index ASC, datetime(created_at) ASC
            """,
            (plan_id,),
        ).fetchall()

    return [PlaceOut.model_validate(dict(r)) for r in rows]


@app.delete("/api/plans/{plan_id}/places/{place_id}")
def delete_place(plan_id: str, place_id: str):
    with get_conn() as conn:
        plan = conn.execute("SELECT id FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found")

        cur = conn.execute(
            "DELETE FROM places WHERE id = ? AND plan_id = ?",
            (place_id, plan_id),
        )
        conn.commit()

    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Place not found")
    return {"ok": True}


@app.get("/api/weather/live")
def weather_live(adcode: str):
    """
    统一天气服务（后端调用高德天气，前端不直连第三方）。
    """
    try:
        return {"weather": get_live_weather_by_adcode(adcode)}
    except WeatherKeyMissing as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except WeatherUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.get("/api/plans/{plan_id}/weather/live")
def plan_weather_live(plan_id: str):
    """
    返回当前规划内地点的实时天气（按 place_id 聚合）。
    只对有 adcode 的地点查询；缺失 adcode 的地点会被跳过并返回原因。
    """
    with get_conn() as conn:
        plan = conn.execute("SELECT id FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found")

        rows = conn.execute(
            "SELECT id, adcode FROM places WHERE plan_id = ? ORDER BY sort_index ASC, datetime(created_at) ASC",
            (plan_id,),
        ).fetchall()

    result: dict[str, object] = {}
    errors: dict[str, str] = {}
    for r in rows:
        place_id = r["id"]
        adcode = (r["adcode"] or "").strip()
        if not adcode:
            errors[place_id] = "Missing adcode"
            continue
        try:
            result[place_id] = get_live_weather_by_adcode(adcode)
        except Exception as e:
            errors[place_id] = str(e)

    return {"weathers": result, "errors": errors}


_ALLOWED_TIME_SLOTS = {"morning", "afternoon", "evening"}


@app.get("/api/plans/{plan_id}/itinerary", response_model=list[ItineraryItemOut])
def get_itinerary(plan_id: str):
    with get_conn() as conn:
        plan = conn.execute("SELECT id FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found")
        rows = conn.execute(
            """
            SELECT * FROM itinerary_items
             WHERE plan_id = ?
             ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC
            """,
            (plan_id,),
        ).fetchall()
    return [ItineraryItemOut.model_validate(dict(r)) for r in rows]


@app.put("/api/plans/{plan_id}/itinerary", response_model=list[ItineraryItemOut])
def update_itinerary(plan_id: str, payload: ItineraryUpdate):
    now = _now_iso()
    with get_conn() as conn:
        plan = conn.execute("SELECT id FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not plan:
            raise HTTPException(status_code=404, detail="Plan not found")

        place_rows = conn.execute(
            "SELECT id FROM places WHERE plan_id = ?",
            (plan_id,),
        ).fetchall()
        place_ids = {r["id"] for r in place_rows}

        for it in payload.items:
            if it.time_slot not in _ALLOWED_TIME_SLOTS:
                raise HTTPException(status_code=400, detail=f"Invalid time_slot: {it.time_slot}")
            if it.place_id not in place_ids:
                raise HTTPException(status_code=400, detail=f"Invalid place_id: {it.place_id}")

        conn.execute("DELETE FROM itinerary_items WHERE plan_id = ?", (plan_id,))
        for it in payload.items:
            conn.execute(
                """
                INSERT INTO itinerary_items (id, plan_id, place_id, time_slot, sort_index, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid4()),
                    plan_id,
                    it.place_id,
                    it.time_slot,
                    it.sort_index,
                    now,
                ),
            )
        conn.commit()

        rows = conn.execute(
            """
            SELECT * FROM itinerary_items
             WHERE plan_id = ?
             ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC
            """,
            (plan_id,),
        ).fetchall()

    return [ItineraryItemOut.model_validate(dict(r)) for r in rows]


@app.post("/api/plans/{plan_id}/ai/summary", response_model=AiSummaryResponse)
def ai_summary(plan_id: str, payload: AiSummaryRequest):
    with get_conn() as conn:
        plan_row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not plan_row:
            raise HTTPException(status_code=404, detail="Plan not found")
        plan = dict(plan_row)

        places_rows = conn.execute(
            """
            SELECT * FROM places
             WHERE plan_id = ?
             ORDER BY sort_index ASC, datetime(created_at) ASC
            """,
            (plan_id,),
        ).fetchall()
        places = [dict(r) for r in places_rows]

        itin_rows = conn.execute(
            """
            SELECT * FROM itinerary_items
             WHERE plan_id = ?
             ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC
            """,
            (plan_id,),
        ).fetchall()
        itinerary = [dict(r) for r in itin_rows]

    # weather summary (best-effort)
    weather_by_place: dict[str, object] = {}
    for p in places:
        adcode = (p.get("adcode") or "").strip()
        if not adcode:
            continue
        try:
            weather_by_place[p["id"]] = get_live_weather_by_adcode(adcode)
        except Exception:
            continue

    # build itinerary grouped text
    place_name = {p["id"]: (p.get("name") or "地点") for p in places}
    groups = {"morning": [], "afternoon": [], "evening": []}
    for it in itinerary:
        groups.get(it["time_slot"], []).append(it["place_id"])

    def _fmt_slot(key: str, label: str) -> str:
        ids = groups.get(key) or []
        if not ids:
            return f"{label}：未安排"
        return f"{label}：" + "、".join(place_name.get(i, i) for i in ids)

    itinerary_text = "\n".join(
        [
            _fmt_slot("morning", "上午"),
            _fmt_slot("afternoon", "下午"),
            _fmt_slot("evening", "晚上"),
        ]
    )

    style = (payload.style or "normal").strip().lower()
    style_hint = {
        "short": "输出 6-10 行以内，直给重点。",
        "normal": "输出 10-18 行左右，分点说明。",
        "detailed": "输出更详细一些，分点+小标题。",
    }.get(style, "输出 10-18 行左右，分点说明。")

    system = (
        "你是一个出行规划助手。你的任务是对用户的出行规划做总结和改进建议。"
        "你必须基于提供的规划信息回答，不要编造不存在的地点或天气。"
        "输出中文，结构清晰，给出：优点、风险/不合理点、可改进建议。"
    )

    context = {
        "plan": {
            "title": plan.get("title"),
            "date": plan.get("date"),
            "budget": plan.get("budget"),
            "people_count": plan.get("people_count"),
            "preferences": plan.get("preferences"),
        },
        "places": [
            {
                "id": p["id"],
                "name": p.get("name"),
                "address": p.get("address"),
                "adcode": p.get("adcode"),
            }
            for p in places
        ],
        "itinerary_text": itinerary_text,
        "weather_by_place": weather_by_place,
    }

    messages = [
        {"role": "system", "content": system},
        {"role": "system", "content": f"输出要求：{style_hint}"},
        {"role": "system", "content": f"规划上下文（JSON）：\n{context}"},
        {"role": "user", "content": "请给出本次规划的 AI 辅助总结。"},
    ]

    try:
        summary = chat_complete(messages)
        return AiSummaryResponse(summary=summary)
    except LlmConfigMissing as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except LlmUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


def _load_plan_bundle(plan_id: str):
    with get_conn() as conn:
        plan_row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not plan_row:
            raise HTTPException(status_code=404, detail="Plan not found")
        plan = dict(plan_row)

        places_rows = conn.execute(
            """
            SELECT * FROM places
             WHERE plan_id = ?
             ORDER BY sort_index ASC, datetime(created_at) ASC
            """,
            (plan_id,),
        ).fetchall()
        places = [dict(r) for r in places_rows]

        itin_rows = conn.execute(
            """
            SELECT * FROM itinerary_items
             WHERE plan_id = ?
             ORDER BY time_slot ASC, sort_index ASC, datetime(created_at) ASC
            """,
            (plan_id,),
        ).fetchall()
        itinerary = [dict(r) for r in itin_rows]

    weather_by_place: dict[str, object] = {}
    for p in places:
        adcode = (p.get("adcode") or "").strip()
        if not adcode:
            continue
        try:
            weather_by_place[p["id"]] = get_live_weather_by_adcode(adcode)
        except Exception:
            continue

    return plan, places, itinerary, weather_by_place


@app.get("/api/plans/{plan_id}/checks")
def plan_checks(plan_id: str):
    plan, places, itinerary, weather_by_place = _load_plan_bundle(plan_id)
    return {"issues": build_checks(plan=plan, places=places, itinerary=itinerary, weather_by_place=weather_by_place)}


@app.get("/api/plans/{plan_id}/export")
def plan_export(plan_id: str, format: str = "md"):
    plan, places, itinerary, weather_by_place = _load_plan_bundle(plan_id)

    fmt = (format or "md").lower().strip()
    if fmt not in {"md", "json"}:
        raise HTTPException(status_code=400, detail="format must be md or json")

    if fmt == "json":
        obj = build_plan_export_json(
            plan=plan, places=places, itinerary=itinerary, weather_by_place=weather_by_place
        )
        return {"format": "json", "content": obj}

    md = build_plan_export_md(plan=plan, places=places, itinerary=itinerary, weather_by_place=weather_by_place)
    return {"format": "md", "content": md}

