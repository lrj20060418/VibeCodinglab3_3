from __future__ import annotations

import os
import time
from typing import Any

import httpx


def _amap_weather_key() -> str | None:
    return os.getenv("AMAP_WEBSERVICE_KEY")


class WeatherKeyMissing(RuntimeError):
    pass


class WeatherUpstreamError(RuntimeError):
    pass


_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_TTL_SECONDS = 10 * 60


def get_live_weather_by_adcode(adcode: str) -> dict[str, Any]:
    adcode = (adcode or "").strip()
    if not adcode:
        raise ValueError("Missing adcode")

    now = time.time()
    cached = _CACHE.get(adcode)
    if cached and now - cached[0] < _TTL_SECONDS:
        return cached[1]

    key = _amap_weather_key()
    if not key:
        raise WeatherKeyMissing("AMAP_WEBSERVICE_KEY is not set")

    url = "https://restapi.amap.com/v3/weather/weatherInfo"
    params = {"city": adcode, "key": key, "extensions": "base"}

    try:
        with httpx.Client(timeout=10.0) as client:
            res = client.get(url, params=params)
            res.raise_for_status()
            data = res.json()
    except Exception as e:
        raise WeatherUpstreamError(f"Failed to call AMap weather: {e}") from e

    if data.get("status") != "1":
        raise WeatherUpstreamError(f"AMap weather error: {data.get('info')}")

    live = (data.get("lives") or [None])[0]
    if not isinstance(live, dict):
        raise WeatherUpstreamError("AMap weather missing lives[0]")

    out = {
        "status": live.get("weather"),
        "temperature": live.get("temperature"),
        "wind_direction": live.get("winddirection"),
        "wind_power": live.get("windpower"),
        "humidity": live.get("humidity"),
        "report_time": live.get("reporttime"),
        "adcode": adcode,
    }

    _CACHE[adcode] = (now, out)
    return out

