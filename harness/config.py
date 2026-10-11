"""Harness service configuration (environment only; `kg.load_dotenv()` loads the nearest .env first).

  HARNESS_PORT              this service (default 8000)
  SIM_SERVER_URL            the sitesim runner, also exported as KG_RUNNER_URL (default http://localhost:8790)
  GATEWAY_URL               Aseel's intervention gateway API (default http://localhost:8787)
  GATEWAY_WEB_URL           its dashboard (default http://localhost:5173)
  HARNESS_TOKEN             bearer the gateway expects on POST /v1/incidents (its HARNESS_TOKEN)
  HARNESS_OUTBOUND_TOKEN    bearer the gateway sends us on routes B-F (its HARNESS_OUTBOUND_TOKEN)
  HELDOUT_SEEDS             comma list, default 301-306 (gate-only; never given to the improver)
  FINAL_SEEDS               comma list, default 401-410
  SUPERVISOR_MODEL          Claude model id for the supervisor (default: the CLI's default)
  SUPERVISOR_MAX_TURNS      default 40
  GATE_TOLERANCE            a zone may not fall by more than this (default 0.01)
  GATE_MIN_GAIN             some zone must rise by at least this (default 0.005)
  KG_* / RAINDROP_*         see kg/config.py
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _seeds(var: str, default: list[int]) -> list[int]:
    raw = os.getenv(var, "").strip()
    return [int(x) for x in raw.split(",") if x.strip()] if raw else default


@dataclass
class Settings:
    port: int = field(default_factory=lambda: int(os.getenv("HARNESS_PORT", "8000")))
    sim_server_url: str = field(default_factory=lambda: os.getenv("SIM_SERVER_URL") or os.getenv("KG_RUNNER_URL") or "http://localhost:8790")
    gateway_url: str = field(default_factory=lambda: os.getenv("GATEWAY_URL", "http://localhost:8787"))
    gateway_web_url: str = field(default_factory=lambda: os.getenv("GATEWAY_WEB_URL", "http://localhost:5173"))
    harness_token: str = field(default_factory=lambda: os.getenv("HARNESS_TOKEN", "dev-harness-token-change-me"))
    outbound_token: str = field(default_factory=lambda: os.getenv("HARNESS_OUTBOUND_TOKEN", ""))
    heldout_seeds: list[int] = field(default_factory=lambda: _seeds("HELDOUT_SEEDS", list(range(301, 307))))
    final_seeds: list[int] = field(default_factory=lambda: _seeds("FINAL_SEEDS", list(range(401, 411))))
    model: str | None = field(default_factory=lambda: os.getenv("SUPERVISOR_MODEL") or None)
    max_turns: int = field(default_factory=lambda: int(os.getenv("SUPERVISOR_MAX_TURNS", "40")))
    tolerance: float = field(default_factory=lambda: float(os.getenv("GATE_TOLERANCE", "0.01")))
    min_gain: float = field(default_factory=lambda: float(os.getenv("GATE_MIN_GAIN", "0.005")))
    supervisor_id: str = "sup-harness-01"
    lead_id: str = "sup-lead-01"
    lead_name: str = "Robotics Lead"


def settings() -> Settings:
    os.environ.setdefault("KG_RUNNER_URL", os.getenv("SIM_SERVER_URL", "http://localhost:8790"))
    return Settings()
