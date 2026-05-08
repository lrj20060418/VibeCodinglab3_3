from __future__ import annotations

import os
from typing import Any

import httpx


class LlmConfigMissing(RuntimeError):
    pass


class LlmUpstreamError(RuntimeError):
    pass


def _get_env(name: str) -> str:
    v = (os.getenv(name) or "").strip()
    if not v:
        raise LlmConfigMissing(f"{name} is not set")
    return v


def chat_complete(messages: list[dict[str, str]], *, temperature: float = 0.6) -> str:
    api_key = _get_env("LLM_API_KEY")
    base_url = _get_env("LLM_BASE_URL")
    model = _get_env("LLM_MODEL")

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }

    try:
        with httpx.Client(timeout=25.0) as client:
            res = client.post(
                base_url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json=payload,
            )
            if res.status_code >= 400:
                detail = ""
                try:
                    detail = str(res.json())
                except Exception:
                    detail = res.text
                raise LlmUpstreamError(
                    f"LLM HTTP {res.status_code} for {base_url}: {detail}"
                )
            data = res.json()
    except Exception as e:
        raise LlmUpstreamError(f"Failed to call LLM: {e}") from e

    content = (
        (((data or {}).get("choices") or [{}])[0].get("message") or {}).get("content")
        or ""
    )
    if not content:
        # Try a few common fallbacks across OpenAI-compatible providers.
        choice0 = ((data or {}).get("choices") or [{}])[0] if isinstance((data or {}).get("choices"), list) else {}
        content = (
            (((choice0 or {}).get("delta") or {}).get("content") or "")
            or ((choice0 or {}).get("text") or "")
            or ((data or {}).get("output_text") or "")
        )

    if not content:
        raise LlmUpstreamError(f"LLM returned empty content: {data}")
    return content

