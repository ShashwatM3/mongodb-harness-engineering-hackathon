"""Process-wide state for the harness service: the two kg clients, live proposals, incidents, and an event bus
the dashboard subscribes to over SSE."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from typing import Any

import kg

from .config import Settings, settings
from .gate import ensure_heldout_seeds

log = logging.getLogger("harness.state")


class EventBus:
    """Fan-out of JSON events (supervisor transcript, incidents, promotions) to SSE subscribers."""

    def __init__(self, keep: int = 500):
        self.history: deque[dict] = deque(maxlen=keep)
        self.subscribers: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    def emit(self, kind: str, **data: Any) -> dict:
        ev = {"kind": kind, "at": time.time(), **data}
        self.history.append(ev)
        for q in list(self.subscribers):
            if self.loop is not None:
                self.loop.call_soon_threadsafe(q.put_nowait, ev)
            else:
                q.put_nowait(ev)
        return ev

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self.subscribers.discard(q)


class State:
    def __init__(self, cfg: Settings | None = None):
        kg.load_dotenv()
        self.cfg = cfg or settings()
        self.improver: kg.KG = kg.connect("improver")
        self.gate: kg.KG = kg.connect("gate")
        self.gate.seed()
        ensure_heldout_seeds(self.gate, self.cfg)
        self.proposals: dict[str, kg.Proposal] = {}          # gate_run_id -> Proposal (evaluate needs the object)
        self.incidents: dict[str, dict] = {}                  # incident_id -> {incident, gate_run_id, revisions, decision}
        self.feedback_seen: set[str] = set()                  # Idempotency-Key dedupe
        self.bus = EventBus()
        self.loop_status: dict = {"running": False, "round": 0, "rounds": 0, "last": None}
        log.info("harness state ready: db=%s env=%s latest brain v%s", self.cfg and self.improver.cfg.db_name, self.improver.env.key, self.gate.latest_version())

    def dumps(self, obj: Any) -> str:
        return json.dumps(obj, default=str)


_state: State | None = None


def get_state() -> State:
    global _state
    if _state is None:
        _state = State()
    return _state
