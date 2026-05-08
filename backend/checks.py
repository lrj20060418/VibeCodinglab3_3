from __future__ import annotations

from typing import Any


def build_checks(
    *,
    plan: dict[str, Any],
    places: list[dict[str, Any]],
    itinerary: list[dict[str, Any]],
    weather_by_place: dict[str, Any],
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []

    def add(level: str, code: str, title: str, detail: str = ""):
        issues.append(
            {
                "level": level,  # info|warn
                "code": code,
                "title": title,
                "detail": detail,
            }
        )

    # plan basics
    if not plan.get("date"):
        add("warn", "plan.missing_date", "未填写日期")

    # places
    if not places:
        add("warn", "places.empty", "还没有添加地点")
        return issues

    missing_adcode = [p for p in places if not (p.get("adcode") or "").strip()]
    if missing_adcode:
        add(
            "warn",
            "places.missing_adcode",
            "部分地点缺少 adcode",
            "缺少 adcode 的地点无法稳定查询天气。",
        )

    # itinerary completeness
    assigned = {it.get("place_id") for it in itinerary if it.get("place_id")}
    unassigned = [p for p in places if p.get("id") not in assigned]
    if unassigned:
        add(
            "warn",
            "itinerary.unassigned",
            "有地点未安排时间段",
            f"未安排数量：{len(unassigned)}",
        )

    # too many in a slot
    by_slot: dict[str, list[str]] = {"morning": [], "afternoon": [], "evening": []}
    for it in itinerary:
        slot = it.get("time_slot")
        pid = it.get("place_id")
        if slot in by_slot and pid:
            by_slot[slot].append(pid)
    for slot, ids in by_slot.items():
        if len(ids) >= 4:
            add(
                "warn",
                "itinerary.too_many",
                "单个时间段地点过多",
                f"{slot} 安排了 {len(ids)} 个地点，可能过于紧凑。",
            )

    # budget heuristic
    budget = plan.get("budget")
    people = plan.get("people_count") or 1
    if isinstance(budget, int) and budget > 0:
        per_person = budget / max(1, int(people))
        if per_person < 80:
            add(
                "warn",
                "plan.low_budget",
                "人均预算偏低",
                f"人均约 ¥{per_person:.0f}，可能需要减少跨区移动或选择更省钱的活动。",
            )

    # rain risk heuristic (AMap base weather text)
    rain_places = []
    for p in places:
        w = weather_by_place.get(p.get("id"))
        if isinstance(w, dict):
            status = str(w.get("status") or "")
            if "雨" in status:
                rain_places.append(p.get("name") or "地点")
    if rain_places:
        add(
            "warn",
            "weather.rain_risk",
            "雨天出行风险",
            "部分地点天气为“雨”，建议准备雨具并考虑室内备选：" + "、".join(rain_places[:5]),
        )

    if not issues:
        add("info", "ok", "未发现明显问题", "可以继续完善地点备注与时间安排。")

    return issues

