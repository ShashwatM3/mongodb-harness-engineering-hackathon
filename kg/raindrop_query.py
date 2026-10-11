"""Raindrop's Query API: the read side, for get_signals(shift_id).

A different host and a different key from the write path in raindrop_sink.py:
  https://query.raindrop.ai, Bearer RAINDROP_QUERY_API_KEY (https://auth.raindrop.ai/org/api_keys)
  schema: https://query.raindrop.ai/v1/openapi.json (beta)

Each event row carries `properties` and `signals: [{id, name, score}]`, so one list call returns
the events and the signals Raindrop matched on them.
"""
from __future__ import annotations

from typing import Any, Optional

import httpx

QUERY_URL = "https://query.raindrop.ai"
PAGE = 500  # the API's maximum


class QueryClient:
    def __init__(self, api_key: str, project_id: Optional[str] = None, *, base_url: str = QUERY_URL,
                 timeout: float = 20.0, transport: Optional[httpx.BaseTransport] = None):
        headers = {"Authorization": f"Bearer {api_key}"}
        if project_id:
            headers["X-Raindrop-Project-Id"] = project_id  # unset: the org's default project
        self.project_id = project_id
        self.http = httpx.Client(base_url=base_url, headers=headers, timeout=timeout, transport=transport)

    def events(self, *, event_name: Optional[str] = None, properties: Optional[dict[str, Any]] = None,
               max_pages: int = 20) -> list[dict]:
        """GET /v1/events, oldest first, following the cursor. `properties` filters by equality."""
        params: dict[str, Any] = {"limit": PAGE, "order_by": "+timestamp"}
        if event_name:
            params["event_name"] = event_name
        for k, v in (properties or {}).items():
            params[f"properties[{k}]"] = str(v).lower() if isinstance(v, bool) else v
        out: list[dict] = []
        for _ in range(max_pages):
            r = self.http.get("/v1/events", params=params)
            r.raise_for_status()
            body = r.json()
            out.extend(body.get("data") or [])
            meta = body.get("meta") or {}
            if not (meta.get("has_more") and meta.get("cursor")):
                break
            params["cursor"] = meta["cursor"]
        return out

    def close(self):
        self.http.close()


def query_client_from_config(cfg, dev: Optional[bool] = None) -> QueryClient:
    """Reads the project the sink writes to (Config.raindrop_target), so dev runs read kg-dev."""
    if not cfg.raindrop_query_key:
        raise RuntimeError("get_signals needs RAINDROP_QUERY_API_KEY (a Query API key, not the write key)")
    dev, project = cfg.raindrop_target(dev)
    if dev and not project:
        raise RuntimeError("dev run and no RAINDROP_DEV_PROJECT_ID: nothing was sent, so there is nothing to read")
    return QueryClient(cfg.raindrop_query_key, project_id=project)
