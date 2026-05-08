from __future__ import annotations

import json
from typing import Any


def _slot_label(slot: str) -> str:
    return {"morning": "上午", "afternoon": "下午", "evening": "晚上"}.get(slot, slot)


def build_plan_export_json(
    *,
    plan: dict[str, Any],
    places: list[dict[str, Any]],
    itinerary: list[dict[str, Any]],
    weather_by_place: dict[str, Any],
) -> dict[str, Any]:
    return {
        "plan": {
            "id": plan.get("id"),
            "title": plan.get("title"),
            "date": plan.get("date"),
            "budget": plan.get("budget"),
            "people_count": plan.get("people_count"),
            "preferences": plan.get("preferences"),
        },
        "places": [
            {
                "id": p.get("id"),
                "name": p.get("name"),
                "address": p.get("address"),
                "lng": p.get("lng"),
                "lat": p.get("lat"),
                "adcode": p.get("adcode"),
            }
            for p in places
        ],
        "itinerary": [
            {
                "place_id": it.get("place_id"),
                "time_slot": it.get("time_slot"),
                "sort_index": it.get("sort_index"),
            }
            for it in itinerary
        ],
        "weather_by_place": weather_by_place,
    }


def build_plan_export_md(
    *,
    plan: dict[str, Any],
    places: list[dict[str, Any]],
    itinerary: list[dict[str, Any]],
    weather_by_place: dict[str, Any],
) -> str:
    title = plan.get("title") or "未命名规划"
    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")
    lines.append("## 基本信息")
    lines.append("")
    lines.append(f"- 日期：{plan.get('date') or '—'}")
    lines.append(f"- 预算：{('¥' + str(plan.get('budget'))) if plan.get('budget') is not None else '—'}")
    lines.append(f"- 人数：{(str(plan.get('people_count')) + ' 人') if plan.get('people_count') is not None else '—'}")
    if plan.get("preferences"):
        lines.append(f"- 偏好：{plan.get('preferences')}")
    lines.append("")

    lines.append("## 地点")
    lines.append("")
    if not places:
        lines.append("- （暂无地点）")
    else:
        for idx, p in enumerate(places, start=1):
            name = p.get("name") or f"地点 {idx}"
            addr = p.get("address") or "—"
            lng = p.get("lng")
            lat = p.get("lat")
            loc = f"{lng:.6f}, {lat:.6f}" if isinstance(lng, (int, float)) and isinstance(lat, (int, float)) else "—"
            w = weather_by_place.get(p.get("id")) if isinstance(weather_by_place, dict) else None
            w_text = "—"
            if isinstance(w, dict):
                s = w.get("status") or "—"
                t = (str(w.get("temperature")) + "°C") if w.get("temperature") is not None else "—"
                w_text = f"{s} · {t}"
            lines.append(f"{idx}. **{name}**")
            lines.append(f"   - 地址：{addr}")
            lines.append(f"   - 坐标：{loc}")
            lines.append(f"   - 天气：{w_text}")
    lines.append("")

    # itinerary grouped
    by_slot: dict[str, list[str]] = {"morning": [], "afternoon": [], "evening": []}
    name_by_id = {p.get("id"): (p.get("name") or "地点") for p in places}
    for it in itinerary:
        slot = it.get("time_slot")
        pid = it.get("place_id")
        if slot in by_slot and pid:
            by_slot[slot].append(name_by_id.get(pid, str(pid)))

    lines.append("## 行程安排")
    lines.append("")
    for slot in ["morning", "afternoon", "evening"]:
        label = _slot_label(slot)
        items = by_slot.get(slot) or []
        if not items:
            lines.append(f"- {label}：未安排")
        else:
            lines.append(f"- {label}：" + "、".join(items))
    lines.append("")

    return "\n".join(lines)


def to_pretty_json(obj: dict[str, Any]) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)

